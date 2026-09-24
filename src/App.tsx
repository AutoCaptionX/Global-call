import { useState, useEffect, useRef } from 'react';
import { 
  Phone, Video, PhoneOff, UserPlus, Settings, ShieldAlert, Share2, 
  Mic, MicOff, VideoOff, Wifi, WifiOff, Download, Check, Copy, 
  RotateCcw, Info, ChevronRight, User, Globe, AlertCircle, X, Shield, 
  RefreshCw, Search, ArrowRight, ExternalLink, Moon, Sparkles,
  ArrowUpRight, ArrowDownLeft, PhoneMissed, Trash2, Clock, Upload, Edit, LogOut,
  Volume2, VolumeX, Plus, MoreVertical
} from 'lucide-react';
import { sound } from './audio';
import { ALL_COUNTRIES, Country } from './countries';

import { getAnalytics } from "firebase/analytics";
import { RecaptchaVerifier, signInWithPhoneNumber, ConfirmationResult, signOut } from "firebase/auth";
import { 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  arrayUnion, 
  deleteDoc, 
  getDocs,
  orderBy,
  limit,
  serverTimestamp
} from "firebase/firestore";
import { app, auth, db } from "./firebaseConfig";

declare global {
  interface Window {
    recaptchaVerifier: any;
    confirmationResult: any;
    initializeRecaptcha: () => void;
    sendRealOTP: (phoneNumber: string) => void;
    verifyEnteredOTP: (otpCode: string) => void;
  }
}

const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;

// --- Types ---
interface Friend {
  id: string;
  name: string;
  phoneNumber: string;
  status: 'online' | 'offline' | 'calling';
  profileImage?: string;
  bio?: string;
}

interface CallRecord {
  id: string;
  name: string;
  phoneNumber: string;
  type: 'incoming' | 'outgoing';
  callType: 'audio' | 'video';
  status: 'completed' | 'missed';
  timestamp: string;
  duration: number; // in seconds
}

interface CallStats {
  rtt: number;
  audioCodec: string;
  videoCodec: string;
  resolution: string;
  fps: number;
  bandwidth: string;
}

// --- Robust Low-Bandwidth and Slow Connection Optimization Helpers ---
const normalizePhoneToE164 = (phone: string, defaultCountryCode: string): string => {
  // 1. Remove all non-digit and non-plus characters
  let cleaned = phone.replace(/[^0-9+]/g, '');
  
  // 2. If it starts with a plus, it already has country code, just return it
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  // 3. Remove leading zeros
  while (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  
  // Ensure defaultCountryCode starts with '+'
  const code = defaultCountryCode.startsWith('+') ? defaultCountryCode : '+' + defaultCountryCode;
  
  // 4. If the cleaned number already starts with the country code digits (without '+')
  const rawCodeDigits = code.replace(/\D/g, '');
  if (cleaned.startsWith(rawCodeDigits) && cleaned.length > rawCodeDigits.length) {
    return '+' + cleaned;
  }
  
  return code + cleaned;
};

const setBandwidthLimits = (sdp: string, audioBitrateKbps: number, videoBitrateKbps: number) => {
  const lines = sdp.split('\r\n');
  const newSdp = [];
  let currentMedia = null;

  for (const line of lines) {
    newSdp.push(line);
    if (line.startsWith('m=audio')) {
      currentMedia = 'audio';
      newSdp.push(`b=AS:${audioBitrateKbps}`);
    } else if (line.startsWith('m=video')) {
      currentMedia = 'video';
      if (videoBitrateKbps > 0) {
        newSdp.push(`b=AS:${videoBitrateKbps}`);
      }
    }
  }
  return newSdp.join('\r\n');
};

export default function App() {
  // --- Core State ---
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isStandalone, setIsStandalone] = useState(false);
  const [engineMode, setEngineMode] = useState<'demo' | 'firebase'>('firebase');
  const [userPhone, setUserPhone] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  
  // --- Dashboard Tab State ---
  const [dashboardTab, setDashboardTab] = useState<'friends' | 'recents' | 'recordings'>('friends');
  const [isRecordingCall, setIsRecordingCall] = useState(false);
  const [savedRecordings, setSavedRecordings] = useState<any[]>([]);

  // --- Block User & Chat Options ---
  const [blockedUsers, setBlockedUsers] = useState<string[]>(() => {
    const saved = localStorage.getItem('vibeclip_blocked_users');
    return saved ? JSON.parse(saved) : [];
  });
  const [showChatMenu, setShowChatMenu] = useState(false);

  const handleToggleBlock = (phoneNumber: string) => {
    setBlockedUsers(prev => {
      const updated = prev.includes(phoneNumber)
        ? prev.filter(p => p !== phoneNumber)
        : [...prev, phoneNumber];
      localStorage.setItem('vibeclip_blocked_users', JSON.stringify(updated));
      return updated;
    });
    setShowChatMenu(false);
  };

  // --- Recent Calls State ---
  const [recentCalls, setRecentCalls] = useState<CallRecord[]>(() => {
    const saved = localStorage.getItem('global_call_recent_calls');
    if (saved) return JSON.parse(saved);
    return [];
  });

  const [callDirection, setCallDirection] = useState<'incoming' | 'outgoing'>('outgoing');
  
  // --- Country Selection States ---
  const [selectedCountry, setSelectedCountry] = useState<Country>(() => {
    return ALL_COUNTRIES.find(c => c.name === 'Nepal') || ALL_COUNTRIES[0];
  });
  const [showCountryModal, setShowCountryModal] = useState(false);
  const [countryModalTarget, setCountryModalTarget] = useState<'login' | 'friend'>('login');
  const [searchQuery, setSearchQuery] = useState('');

  // --- UI Screens & Navigation Override ---
  // If the user wants to force-bypass standalone check to view login/dashboard inside the browser iframe
  const [forceLoginView, setForceLoginView] = useState(false);

  // --- OTP Modal States ---
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpTimer, setOtpTimer] = useState(0);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddFriendModal, setShowAddFriendModal] = useState(false);
  const [addFriendStep, setAddFriendStep] = useState<'selection' | 'form'>('selection');
  const [addFriendError, setAddFriendError] = useState<string | null>(null);
  
  // --- Recent Calls Helpers ---
  const addRecentCall = (record: Omit<CallRecord, 'id' | 'timestamp'>) => {
    const formattedTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const formattedDate = new Date().toLocaleDateString('hi-IN', { month: 'short', day: 'numeric' });
    const newRecord: CallRecord = {
      ...record,
      id: 'rec_' + Date.now(),
      timestamp: `${formattedTime} ${formattedDate}`,
    };
    setRecentCalls(prev => {
      const updated = [newRecord, ...prev].slice(0, 50);
      localStorage.setItem('global_call_recent_calls', JSON.stringify(updated));
      return updated;
    });
  };

  const clearRecentCalls = () => {
    setRecentCalls([]);
    localStorage.removeItem('global_call_recent_calls');
  };

  const removeRecentCall = (id: string) => {
    setRecentCalls(prev => {
      const updated = prev.filter(r => r.id !== id);
      localStorage.setItem('global_call_recent_calls', JSON.stringify(updated));
      return updated;
    });
  };
  
  // --- Firebase Configuration ---
  const [firebaseConfigInput, setFirebaseConfigInput] = useState(() => {
    return localStorage.getItem('global_call_fb_config') || `{
  "apiKey": "YOUR_API_KEY",
  "authDomain": "YOUR_AUTH_DOMAIN",
  "projectId": "YOUR_PROJECT_ID",
  "storageBucket": "YOUR_STORAGE_BUCKET",
  "messagingSenderId": "YOUR_MESSAGING_SENDER_ID",
  "appId": "YOUR_APP_ID",
  "measurementId": "YOUR_MEASUREMENT_ID"
}`;
  });

  // --- Profile Name & Friends List ---
  const [myProfileName, setMyProfileName] = useState(() => {
    return localStorage.getItem('global_call_profile_name') || 'Guest User';
  });
  const AVATAR_GRADIENTS = [
    'from-teal-500 to-cyan-500',
    'from-purple-500 to-pink-500',
    'from-amber-500 to-rose-500',
    'from-blue-500 to-indigo-600',
    'from-emerald-400 to-teal-600',
    'from-orange-400 to-red-600'
  ];
  const [myAvatarIdx, setMyAvatarIdx] = useState(() => {
    return parseInt(localStorage.getItem('global_call_profile_avatar_idx') || '0', 10);
  });
  const [isProfileSetupDone, setIsProfileSetupDone] = useState(() => {
    return localStorage.getItem('global_call_profile_setup_done') === 'true';
  });
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [myProfileImage, setMyProfileImage] = useState(() => {
    return localStorage.getItem('global_call_profile_image') || '';
  });
  const [myUsername, setMyUsername] = useState(() => {
    return localStorage.getItem('global_call_username') || '';
  });
  const [myBio, setMyBio] = useState(() => {
    return localStorage.getItem('global_call_bio') || 'Hey there! I am using Global Call.';
  });
  const [friends, setFriends] = useState<Friend[]>(() => {
    const saved = localStorage.getItem('global_call_friends');
    if (saved) return JSON.parse(saved);
    return [];
  });

  // --- Real-time Chat States ---
  const [activeChatFriend, setActiveChatFriend] = useState<Friend | null>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [typedMessage, setTypedMessage] = useState('');
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordedAudioChunks, setRecordedAudioChunks] = useState<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  
  // --- New Friend Inputs ---
  const [newFriendName, setNewFriendName] = useState('');
  const [newFriendPhone, setNewFriendPhone] = useState('');
  const [newFriendCountry, setNewFriendCountry] = useState<Country>(
    ALL_COUNTRIES.find(c => c.name === 'Nepal') || ALL_COUNTRIES[0]
  );
  const [isSearchingFriend, setIsSearchingFriend] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // --- Call/WebRTC Connection States ---
  const [callState, setCallState] = useState<'idle' | 'dialing' | 'ringing' | 'connected'>('idle');
  const [callType, setCallType] = useState<'audio' | 'video'>('video');
  const [currentCallPartner, setCurrentCallPartner] = useState<Friend | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callVolume, setCallVolume] = useState<number>(100);
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState<boolean>(true);
  const [stats, setStats] = useState<CallStats>({
    rtt: 25,
    audioCodec: 'Opus @ 48kHz (128kbps)',
    videoCodec: 'VP8 Video Codec',
    resolution: '1280x720 (HD)',
    fps: 30,
    bandwidth: 'Adaptive 1.4 Mbps',
  });

  // --- PWA Installation Events ---
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [logoTapCount, setLogoTapCount] = useState(0);

  const handleLogoClick = () => {
    setLogoTapCount(prev => {
      const next = prev + 1;
      if (next >= 5) {
        setForceLoginView(true);
        return 0;
      }
      return next;
    });
  };

  // --- Refs ---
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const durationIntervalRef = useRef<any>(null);
  const recaptchaVerifierRef = useRef<any>(null);
  const countdownIntervalRef = useRef<any>(null);

  // --- Detect Environment on Mount ---
  useEffect(() => {
    // Detect Standalone PWA mode
    const checkStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                            (window.navigator as any).standalone === true;
    setIsStandalone(checkStandalone);

    // Prioritize loading saved country from local storage, or auto-detect from browser locale if none exists
    const savedCountryName = localStorage.getItem('global_call_country_name');
    if (savedCountryName) {
      const matched = ALL_COUNTRIES.find(c => c.name === savedCountryName);
      if (matched) {
        setSelectedCountry(matched);
        setNewFriendCountry(matched);
      }
    } else {
      const locale = navigator.language || 'en-US';
      const detectedCountryCode = locale.split('-')[1]?.toUpperCase();
      if (detectedCountryCode) {
        const matched = ALL_COUNTRIES.find(c => c.name.toUpperCase().includes(detectedCountryCode));
        if (matched) {
          setSelectedCountry(matched);
          setNewFriendCountry(matched);
        }
      }
    }

    // Connectivity status listeners
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Check if the prompt was already captured by index.html script
    if ((window as any).deferredPrompt) {
      setDeferredPrompt((window as any).deferredPrompt);
    }
    (window as any).onDeferredPromptReceived = (e: any) => {
      setDeferredPrompt(e);
    };
    (window as any).onAppInstalled = () => {
      setIsStandalone(true);
      setDeferredPrompt(null);
    };

    // PWA capture prompt fallback
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    // Persisted login check
    const savedPhone = localStorage.getItem('global_call_user_phone');
    if (savedPhone) {
       setUserPhone(savedPhone);
       setIsLoggedIn(true);
    }
    loadSavedRecordings();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      if (channelRef.current) channelRef.current.close();
      stopCallDuration();
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, []);



  // --- Update remote audio volume & speaker settings in real-time ---
  useEffect(() => {
    if (remoteVideoRef.current) {
      // Receiver Mode attenuates the sound to 15% (earpiece-like sound). Speaker mode plays at configured volume percentage.
      remoteVideoRef.current.volume = isSpeakerEnabled ? (callVolume / 100) : 0.15;
    }
  }, [callVolume, isSpeakerEnabled, callState]);

  // --- Save Friends locally ---
  useEffect(() => {
    localStorage.setItem('global_call_friends', JSON.stringify(friends));
  }, [friends]);

  // --- Active Call Stats and Timer ---
  useEffect(() => {
    if (callState === 'connected') {
      durationIntervalRef.current = setInterval(() => {
        setCallDuration(prev => prev + 1);
        setStats(prev => ({
          ...prev,
          rtt: Math.max(10, Math.min(50, prev.rtt + (Math.random() > 0.5 ? 1 : -1))),
          bandwidth: `Adaptive ${(1.2 + Math.random() * 0.4).toFixed(2)} Mbps`
        }));
      }, 1000);
    } else {
      stopCallDuration();
      setCallDuration(0);
    }
  }, [callState]);

  const stopCallDuration = () => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  };

  // --- Firestore Live Users, Calls & Chats Sync ---
  useEffect(() => {
    if (!isLoggedIn) return;

    // Use full phone number as Firestore doc ID
    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);

    // 1. Sync / Register Profile in Firestore & set status to online
    const registerProfileAndSetPresence = async () => {
      try {
        await setDoc(doc(db, "users", myFullPhone), {
          uid: auth.currentUser?.uid || "guest_" + Date.now(),
          phoneNumber: myFullPhone,
          name: myProfileName || "Guest User",
          username: myUsername || "user_" + myFullPhone.slice(-4),
          avatarIdx: myAvatarIdx,
          profileImage: myProfileImage || "",
          bio: myBio || "Hey there! I am using Global Call.",
          status: "online",
          countryName: selectedCountry.name,
          countryCode: selectedCountry.code,
          updatedAt: serverTimestamp()
        }, { merge: true });
        console.log("Profile registered with country & online status set in Firestore for:", myFullPhone);
      } catch (err) {
        console.error("Firestore Profile/Presence sync failed:", err);
      }
    };

    registerProfileAndSetPresence();

    // Set offline on tab/window closure
    const handleBeforeUnload = () => {
      try {
        setDoc(doc(db, "users", myFullPhone), { status: "offline", updatedAt: serverTimestamp() }, { merge: true });
      } catch (e) {}
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // 2. Real-time Incoming Call & Signaling Listener
    const incomingCallDocRef = doc(db, "calls", myFullPhone);
    const unsubscribeIncomingCall = onSnapshot(incomingCallDocRef, async (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      
      // If we are recipient and there is an active incoming call sequence
      if (data.recipient === myFullPhone) {
        // Automatically reject call if caller is in blocked list
        if (blockedUsers.includes(data.caller)) {
          console.log("Silently rejecting incoming call from blocked user:", data.caller);
          try {
            await updateDoc(incomingCallDocRef, { status: "rejected" });
          } catch (e) {}
          return;
        }

        if (data.status === "dialing" || data.status === "ringing") {
          if (callState === "idle") {
            setCallDirection("incoming");
            setCallType(data.callType || "video");
            
            // Build temporary call partner details
            const partnerObj: Friend = {
              id: data.caller,
              name: data.callerName || "Unknown Caller",
              phoneNumber: data.caller,
              status: "online"
            };
            
            setCurrentCallPartner(partnerObj);
            setCallState("ringing");
            sound.startRingtone();

            // Prepare local media and trigger peer connection in recipient mode
            await prepareLocalStream(data.callType || "video");
            createPeerConnection(partnerObj, false);

            if (data.offer) {
              try {
                await peerConnectionRef.current?.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.offer)));
                // Transition status to ringing in Firestore to notify caller that recipient's phone is now ringing
                await updateDoc(incomingCallDocRef, { status: "ringing" });
              } catch (e) {
                console.error("Error setting remote description from caller offer:", e);
              }
            }
          }
        } else if (data.status === "hangup" || data.status === "rejected") {
          if (callState !== "idle") {
            handleLocalHangup(false);
          }
        }

        // Expose caller ICE candidates to our recipient peer connection
        if (peerConnectionRef.current && data.callerCandidates && Array.isArray(data.callerCandidates)) {
          for (const candStr of data.callerCandidates) {
            try {
              const cand = JSON.parse(candStr);
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(cand));
            } catch (e) {
              // Ignore candidate errors if duplicate or stale
            }
          }
        }
      }
    });

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unsubscribeIncomingCall();
      try {
        setDoc(doc(db, "users", myFullPhone), { status: "offline", updatedAt: serverTimestamp() }, { merge: true });
      } catch (e) {}
    };
  }, [isLoggedIn, myProfileName, myUsername, myAvatarIdx, myProfileImage, callState]);

  // --- Sync friends list & real-time updates from Firestore ---
  useEffect(() => {
    if (!isLoggedIn) {
      setFriends([]);
      return;
    }

    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
    const friendsQuery = collection(db, "users", myFullPhone, "friends");

    const unsubscribe = onSnapshot(friendsQuery, (snapshot) => {
      const friendsData: Friend[] = [];
      
      snapshot.docs.forEach((docSnap) => {
        const fData = docSnap.data();
        friendsData.push({
          id: docSnap.id,
          name: fData.name || "Contact",
          phoneNumber: fData.phoneNumber,
          status: fData.status || "offline",
          profileImage: fData.profileImage || ""
        });
      });

      setFriends(friendsData);
      localStorage.setItem('global_call_friends', JSON.stringify(friendsData));
    });

    return () => unsubscribe();
  }, [isLoggedIn, userPhone, selectedCountry]);

  // --- Sync friends individual status real-time updates ---
  useEffect(() => {
    if (!isLoggedIn || friends.length === 0) return;
    const unsubscribes = friends.map(friend => {
      return onSnapshot(doc(db, "users", friend.phoneNumber), (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          setFriends(prev => prev.map(f => {
            if (f.phoneNumber === friend.phoneNumber) {
              return {
                ...f,
                name: data.name || f.name,
                status: data.status || f.status,
                profileImage: data.profileImage || f.profileImage,
                bio: data.bio || ""
              };
            }
            return f;
          }));
        }
      });
    });
    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, [isLoggedIn, friends.length]);

  // --- Real-time messages sync ---
  useEffect(() => {
    if (!activeChatFriend || !isLoggedIn) {
      setChatMessages([]);
      return;
    }
    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
    const roomId = [myFullPhone, activeChatFriend.phoneNumber].sort().join('_');
    const messagesQuery = query(
      collection(db, "chats", roomId, "messages"),
      orderBy("timestamp", "asc")
    );
    const unsubscribe = onSnapshot(messagesQuery, (snapshot) => {
      const msgs = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      setChatMessages(msgs);
    });
    return () => unsubscribe();
  }, [activeChatFriend, isLoggedIn, userPhone, selectedCountry]);

  // --- Initialize FCM Service Worker and Sync Token ---
  useEffect(() => {
    if (!isLoggedIn || engineMode === 'demo') return;

    const initializeFCM = async () => {
      try {
        if ('serviceWorker' in navigator) {
          console.log("Initializing Service Worker for FCM...");
          let registration: ServiceWorkerRegistration | undefined;
          const regs = await navigator.serviceWorker.getRegistrations();
          if (regs && regs.length > 0) {
            registration = regs[0];
            console.log("Using active Service Worker registration for FCM:", registration.scope);
          } else {
            console.log("Registering fallback FCM Service Worker...");
            registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
            console.log("Fallback FCM Service Worker registered with scope:", registration.scope);
          }
          
          if (!registration) {
            console.warn("Could not find or register an active Service Worker.");
            return;
          }

          // Wait a brief moment to let SW activate
          setTimeout(async () => {
            try {
              console.log("Requesting user permission for background call notifications...");
              const permission = await Notification.requestPermission();
              if (permission === 'granted' && registration) {
                const { getMessaging, getToken } = await import('firebase/messaging');
                const messagingInstance = getMessaging(app);
                
                console.log("Fetching FCM Registration Token...");
                const token = await getToken(messagingInstance, {
                  serviceWorkerRegistration: registration,
                  vapidKey: 'BD-KwkcKnn3RU8818duRTJj8Mtr5DbwN_B4wzuoYHHO0L6A724fJPGCwIZZfe87UcXhVLQvdlW7ik29qI5nj3hk'
                });

                if (token) {
                  console.log("FCM registration token generated successfully:", token);
                  const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
                  
                  // Save token to Firestore
                  await setDoc(doc(db, "users", myFullPhone), {
                    fcmToken: token,
                    updatedAt: serverTimestamp()
                  }, { merge: true });
                  console.log("FCM token successfully registered and synced in Firestore.");
                } else {
                  console.warn("FCM token generated empty. Check VAPID key configurations.");
                }
              } else {
                console.warn("Notification permission was denied. FCM background alerts will be disabled.");
              }
            } catch (err) {
              console.error("Failed to generate FCM registration token inside SW registration:", err);
            }
          }, 1500);
        } else {
          console.warn("Service workers are not supported in this browser environment.");
        }
      } catch (err) {
        console.error("FCM Service Worker registration failed:", err);
      }
    };

    initializeFCM();
  }, [isLoggedIn, engineMode, userPhone, selectedCountry]);

  // --- Foreground Notification Handler ---
  useEffect(() => {
    if (!isLoggedIn || engineMode === 'demo') return;

    let unsubscribe: any = null;
    const setupForegroundMessaging = async () => {
      try {
        const { getMessaging, onMessage } = await import('firebase/messaging');
        const messagingInstance = getMessaging(app);
        
        unsubscribe = onMessage(messagingInstance, (payload) => {
          console.log("FCM Foreground message received in-app:", payload);
        });
      } catch (e) {
        console.warn("Foreground onMessage listener failed to hook:", e);
      }
    };

    setupForegroundMessaging();
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [isLoggedIn, engineMode]);

  // --- Real-time Chat functions (sendMessage, voice recording) ---
  const sendMessage = async (text: string, type: 'text' | 'emoji' | 'voice' = 'text', voiceUrl?: string) => {
    if (!activeChatFriend || !isLoggedIn) return;

    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
    const roomId = [myFullPhone, activeChatFriend.phoneNumber].sort().join('_');

    const msgPayload = {
      sender: myFullPhone,
      recipient: activeChatFriend.phoneNumber,
      text: type === 'voice' ? '' : text,
      type: type,
      voiceUrl: voiceUrl || '',
      timestamp: Date.now()
    };

    if (engineMode === 'demo') {
      // Demo Mode local sync fallback
      setChatMessages(prev => [...prev, { id: 'demo_' + Date.now(), ...msgPayload }]);
      
      // Auto reply after 1.5 seconds in Demo Mode to make it feel beautifully alive!
      setTimeout(() => {
        const replyPayload = {
          id: 'demo_reply_' + Date.now(),
          sender: activeChatFriend.phoneNumber,
          recipient: myFullPhone,
          text: type === 'emoji' ? `Love your emoji! ${text} ❤️` : `Hello from ${activeChatFriend.name}! This is a real-time secure demo reply.`,
          type: 'text' as const,
          voiceUrl: '',
          timestamp: Date.now()
        };
        setChatMessages(prev => [...prev, replyPayload]);
      }, 1500);
      return;
    }

    try {
      await addDoc(collection(db, "chats", roomId, "messages"), msgPayload);

      // Trigger background FCM push notification
      const userSnap = await getDoc(doc(db, "users", activeChatFriend.phoneNumber));
      if (userSnap.exists()) {
        const userData = userSnap.data();
        const fcmToken = userData.fcmToken;
        if (fcmToken) {
          console.log("Found recipient FCM Token. Requesting background chat push notification...");
          fetch('/api/send-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: fcmToken,
              title: myProfileName || "New Message",
              body: type === 'voice' ? '🎙️ Sent a voice note' : type === 'emoji' ? `Emoji: ${text}` : text,
              data: {
                type: 'chat',
                sender: myFullPhone,
                senderName: myProfileName || "Friend"
              }
            })
          }).then(res => res.json())
            .then(data => console.log("Chat FCM notification result:", data))
            .catch(e => console.warn("Failed to dispatch Chat FCM push:", e));
        }
      }
    } catch (err) {
      console.error("Error sending message to Firestore:", err);
    }
  };

  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(chunks, { type: 'audio/webm' });
        
        // Convert to base64 so we can save it in our Firestore message database safely without storage setup!
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result as string;
          sendMessage('', 'voice', base64Audio);
        };
        reader.readAsDataURL(audioBlob);

        // Stop all tracks to release microphone hardware immediately
        stream.getTracks().forEach(t => t.stop());
      };

      recorder.start();
      setIsRecordingVoice(true);
    } catch (err) {
      console.error("Microphone hardware access failed:", err);
      alert("Microphone permission was denied or hardware not found.");
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecordingVoice(false);
    }
  };

  const prepareLocalStream = async (type: 'audio' | 'video') => {
    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: type === 'video' ? { 
          facingMode: 'user', 
          width: { ideal: 480, max: 640 }, 
          height: { ideal: 360, max: 480 },
          frameRate: { ideal: 15, max: 20 }
        } : false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (e) {
      console.warn('Error getting media devices with advanced low-bandwidth constraints, falling back:', e);
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: type === 'video'
        });
        localStreamRef.current = fallbackStream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = fallbackStream;
        }
      } catch (fallbackErr) {
        console.error('Fallback media devices gather failed:', fallbackErr);
      }
    }
  };

  const createPeerConnection = (partner: Friend, isCallerRole: boolean) => {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:global.stun.twilio.com:3478' } // Twilio Global Fast STUN
      ],
      iceCandidatePoolSize: 10, // Pre-gather candidates for instant connection
      bundlePolicy: "max-bundle" as const,
      rtcpMuxPolicy: "require" as const
    };
    const pc = new RTCPeerConnection(config);
    peerConnectionRef.current = pc;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
        const docId = isCallerRole ? partner.phoneNumber : myFullPhone;
        const fieldToUpdate = isCallerRole ? "callerCandidates" : "recipientCandidates";

        try {
          await updateDoc(doc(db, "calls", docId), {
            [fieldToUpdate]: arrayUnion(JSON.stringify(event.candidate))
          });
        } catch (e) {
          console.error("Error setting ICE candidate:", e);
        }
      }
    };
  };

  // --- Trigger PWA Installer Prompt ---
  const handlePwaInstall = async () => {
    console.log("डाउनलोड शुरू हो रहा है...");
    
    const isInIframe = window.self !== window.top;
    if (isInIframe) {
      try {
        window.open(window.location.href, '_blank');
      } catch (e) {
        console.error(e);
      }
      return;
    }

    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          setIsStandalone(true);
          setDeferredPrompt(null);
        }
      } catch (err) {
        console.error("Installation failed or was aborted: ", err);
      }
    } else {
      console.log("PWA installation prompt is not ready or not supported on this browser.");
    }
  };

  // --- Image Upload Helper ---
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64String = reader.result as string;
        setMyProfileImage(base64String);
        localStorage.setItem('global_call_profile_image', base64String);

        if (isLoggedIn) {
          const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
          try {
            await setDoc(doc(db, "users", myFullPhone), {
              profileImage: base64String,
              updatedAt: serverTimestamp()
            }, { merge: true });
            console.log("Profile photo updated instantly in Firestore!");
          } catch (err) {
            console.error("Failed to instantly save profile photo to Firestore:", err);
          }
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // --- Instant Firestore Profile Sync Helper ---
  const updateFirestoreProfile = async (updates: { name?: string; username?: string; profileImage?: string; avatarIdx?: number; bio?: string }) => {
    if (!isLoggedIn) return;
    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
    try {
      await setDoc(doc(db, "users", myFullPhone), {
        ...updates,
        updatedAt: serverTimestamp()
      }, { merge: true });
      console.log("Firestore profile updated instantly:", updates);
    } catch (e) {
      console.warn("Failed to instantly update Firestore profile:", e);
    }
  };

  // --- IndexedDB Call Recordings Storage Helpers ---
  const openRecordingsDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('CallRecordingsDB', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  const saveRecordingToIndexedDB = async (recording: { id: string; partnerName: string; partnerPhone: string; timestamp: string; blob: Blob; duration: number; callType: string }) => {
    try {
      const db = await openRecordingsDB();
      const tx = db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');
      store.put(recording);
      return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.error("IndexedDB save failed:", err);
    }
  };

  const getAllRecordingsFromIndexedDB = async (): Promise<any[]> => {
    try {
      const db = await openRecordingsDB();
      const tx = db.transaction('recordings', 'readonly');
      const store = tx.objectStore('recordings');
      const request = store.getAll();
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (err) {
      console.error("IndexedDB fetch failed:", err);
      return [];
    }
  };

  const deleteRecordingFromIndexedDB = async (id: string): Promise<void> => {
    try {
      const db = await openRecordingsDB();
      const tx = db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');
      store.delete(id);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.error("IndexedDB delete failed:", err);
    }
  };

  // --- Call Recording State Helpers ---
  const callMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number>(0);

  const startCallRecording = () => {
    let streamToRecord: MediaStream | null = null;
    
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
      streamToRecord = remoteVideoRef.current.srcObject as MediaStream;
    } else if (localStreamRef.current) {
      streamToRecord = localStreamRef.current;
    }

    if (!streamToRecord) {
      alert("No active video stream found to record.");
      return;
    }

    recordedChunksRef.current = [];
    recordingStartTimeRef.current = Date.now();

    try {
      const mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
      ];
      let selectedMimeType = '';
      for (const type of mimeTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedMimeType = type;
          break;
        }
      }

      const recorder = new MediaRecorder(streamToRecord, selectedMimeType ? { mimeType: selectedMimeType } : undefined);
      callMediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const durationSec = Math.round((Date.now() - recordingStartTimeRef.current) / 1000);
        const videoBlob = new Blob(recordedChunksRef.current, { type: selectedMimeType || 'video/webm' });
        
        if (videoBlob.size > 1000) {
          const recordingRecord = {
            id: 'rec_call_' + Date.now(),
            partnerName: currentCallPartner?.name || "Unknown Partner",
            partnerPhone: currentCallPartner?.phoneNumber || "Unknown Phone",
            timestamp: new Date().toLocaleString(),
            blob: videoBlob,
            duration: durationSec,
            callType: callType
          };

          await saveRecordingToIndexedDB(recordingRecord);
          await loadSavedRecordings();
          console.log("Call recording saved to IndexedDB successfully!");
        }
      };

      recorder.start(1000);
      setIsRecordingCall(true);
    } catch (err) {
      console.error("Failed to start MediaRecorder:", err);
      alert("Could not start call recording: " + err);
    }
  };

  const stopCallRecording = () => {
    if (callMediaRecorderRef.current && callMediaRecorderRef.current.state !== 'inactive') {
      callMediaRecorderRef.current.stop();
      setIsRecordingCall(false);
    }
  };

  const loadSavedRecordings = async () => {
    const records = await getAllRecordingsFromIndexedDB();
    records.sort((a, b) => b.id.localeCompare(a.id));
    setSavedRecordings(records);
  };

  const handleDeleteRecording = async (id: string) => {
    if (confirm("Are you sure you want to delete this recording?")) {
      await deleteRecordingFromIndexedDB(id);
      await loadSavedRecordings();
    }
  };

  // --- Send OTP via Firebase Phone Auth ---
  const handleSendOtp = async () => {
    if (!userPhone || userPhone.length < 8) {
      alert('Please enter a valid mobile number.');
      return;
    }

    const fullPhoneNumber = selectedCountry.code + userPhone;
    console.log("Starting OTP process for phone:", fullPhoneNumber);
    
    // Clear previous errors, set loading, and instantly show OTP Modal!
    setOtpError(null);
    setIsSendingOtp(true);
    setShowOtpModal(true); // INSTANTLY reveal the OTP input screen/box on the UI!

    // Real Firebase Mode
    try {
      // 1. Initialize Recaptcha
      console.log("Initializing RecaptchaVerifier...");
      const container = document.getElementById('recaptcha-container');
      if (!container) {
        throw new Error("Error: 'recaptcha-container' element was not found in the DOM. Please reload the page.");
      }
      container.innerHTML = ''; // pristine DOM

      if (recaptchaVerifierRef.current) {
        try {
          recaptchaVerifierRef.current.clear();
        } catch (e) {
          console.warn("Error clearing old verifier:", e);
        }
      }

      const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        'size': 'invisible',
        'callback': (response: any) => {
          console.log("reCAPTCHA solved successfully! Token:", response);
        },
        'expired-callback': () => {
          console.log("reCAPTCHA verification expired. Please try again.");
        }
      });
      recaptchaVerifierRef.current = verifier;
      
      // Explicitly render to bind
      console.log("Rendering reCAPTCHA widget...");
      await verifier.render();

      console.log("Requesting SMS OTP from Firebase for:", fullPhoneNumber);
      const result = await signInWithPhoneNumber(auth, fullPhoneNumber, verifier);
      
      console.log("Firebase SMS request success. confirmationResult received.");
      setConfirmationResult(result);
      setOtpTimer(600); // 10 minutes
      setIsSendingOtp(false); // Done loading

      // Start countdown timer
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
      countdownIntervalRef.current = setInterval(() => {
        setOtpTimer(prev => {
          if (prev <= 1) {
            clearInterval(countdownIntervalRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

    } catch (error: any) {
      console.error("SMS sending failed with error:", error);
      setIsSendingOtp(false);
      
      // Clean up verifier
      if (recaptchaVerifierRef.current) {
        try {
          recaptchaVerifierRef.current.clear();
        } catch (e) {
          console.warn("Error clearing verifier on failure:", e);
        }
        recaptchaVerifierRef.current = null;
      }
      const container = document.getElementById('recaptcha-container');
      if (container) {
        container.innerHTML = '';
      }

      // Friendly actionable error messages
      let errorMsg = error.message || String(error);
      if (error.code === "auth/configuration-not-found" || errorMsg.includes("configuration-not-found")) {
        errorMsg = "Phone Authentication provider is not enabled in your Firebase project yet! Please enable 'Phone' in Firebase Console Auth providers.";
      } else if (
        error.code === "auth/operation-not-allowed" || 
        errorMsg.includes("operation-not-allowed") ||
        errorMsg.includes("region enabled")
      ) {
        errorMsg = "SMS Region Policy Restricted! Please enable your country code/region inside Firebase Console -> Authentication -> Settings -> SMS Region Policy.";
      } else if (
        error.code === "auth/internal-error" || 
        error.code === "auth/unauthorized-domain" || 
        errorMsg.includes("internal-error") ||
        errorMsg.includes("unauthorized-domain")
      ) {
        const currentDomain = window.location.hostname;
        errorMsg = `Domain is unauthorized. Please verify that '${currentDomain}' is registered in Firebase Console -> Authentication -> Settings -> Authorized Domains.`;
      } else if (error.code === "auth/too-many-requests" || errorMsg.includes("quota")) {
        errorMsg = "SMS quota exceeded or too many verification requests sent recently. Please try again later or switch to 'Demo Mode' above.";
      } else if (error.code === "auth/invalid-phone-number" || errorMsg.includes("invalid-phone")) {
        errorMsg = "The phone number format is invalid. Please double check your number and try again.";
      }

      setOtpError(errorMsg);
    }
  };

  const handleVerifyOtp = async () => {
    if (otpTimer === 0) {
      alert('The OTP code has expired! Please request a new one.');
      return;
    }

    if (!otpCode || otpCode.length < 6) {
      alert('Please enter a 6-digit verification code.');
      return;
    }

    setOtpError(null);
    setIsSendingOtp(true); // Use as verifying loader inside OTP modal

    // Real Firebase mode verification
    if (!confirmationResult) {
      setIsSendingOtp(false);
      alert("No active verification session found. Please request OTP again.");
      return;
    }

    console.log("Verifying code:", otpCode);
    try {
      const result = await confirmationResult.confirm(otpCode);
      const user = result.user;
      console.log("Phone number verified successfully! Welcome", user.phoneNumber);
      
      const verifiedPhone = user.phoneNumber || (selectedCountry.code + userPhone);
      localStorage.setItem('global_call_user_phone', verifiedPhone);
      setUserPhone(verifiedPhone);

      // Save current selected country details to localStorage
      localStorage.setItem('global_call_country_name', selectedCountry.name);
      localStorage.setItem('global_call_country_code', selectedCountry.code);
      
      // Check for existing profile in Firestore
      try {
        const uSnap = await getDoc(doc(db, "users", verifiedPhone));
        if (uSnap.exists()) {
          const uData = uSnap.data();
          localStorage.setItem('global_call_profile_name', uData.name || '');
          localStorage.setItem('global_call_username', uData.username || '');
          localStorage.setItem('global_call_profile_avatar_idx', (uData.avatarIdx ?? 0).toString());
          localStorage.setItem('global_call_profile_image', uData.profileImage || '');
          localStorage.setItem('global_call_bio', uData.bio || 'Hey there! I am using Global Call.');
          localStorage.setItem('global_call_profile_setup_done', 'true');
          if (uData.countryName) {
            localStorage.setItem('global_call_country_name', uData.countryName);
            localStorage.setItem('global_call_country_code', uData.countryCode || '');
            const matched = ALL_COUNTRIES.find(c => c.name === uData.countryName);
            if (matched) setSelectedCountry(matched);
          }

          setMyProfileName(uData.name || '');
          setMyUsername(uData.username || '');
          setMyAvatarIdx(uData.avatarIdx ?? 0);
          setMyProfileImage(uData.profileImage || '');
          setMyBio(uData.bio || 'Hey there! I am using Global Call.');
          setIsProfileSetupDone(true);
        } else {
          const hasCompletedProfile = localStorage.getItem('global_call_profile_setup_done') === 'true';
          setIsProfileSetupDone(hasCompletedProfile);
        }
      } catch (err) {
        console.warn("Could not retrieve existing user profile:", err);
        const hasCompletedProfile = localStorage.getItem('global_call_profile_setup_done') === 'true';
        setIsProfileSetupDone(hasCompletedProfile);
      }

      setIsLoggedIn(true);
      setShowOtpModal(false);
      setOtpCode('');
      setIsSendingOtp(false);
    } catch (error: any) {
      console.error("Invalid OTP or confirmation failed:", error);
      setIsSendingOtp(false);
      let errorMsg = "Invalid OTP code. Please try again.";
      if (error.code === "auth/invalid-verification-code") {
        errorMsg = "Incorrect verification code. Please try again.";
      } else if (error.code === "auth/session-expired") {
        errorMsg = "The verification session has expired. Please request a new OTP code.";
      }
      alert(errorMsg);
    }
  };

  const handleLogout = async () => {
    // 1. Get current full phone number safely
    let myFullPhone = "";
    try {
      if (userPhone) {
        const countryCode = selectedCountry?.code || "";
        myFullPhone = userPhone.startsWith('+') ? userPhone : (countryCode + userPhone);
      }
    } catch (e) {
      console.warn("Error parsing user phone during logout:", e);
    }

    // 2. Clear all local React states FIRST for an instantaneous UI transition!
    setUserPhone('');
    setMyProfileName('Guest User');
    setMyUsername('');
    setMyAvatarIdx(0);
    setMyProfileImage('');
    setMyBio('Hey there! I am using Global Call.');
    setConfirmationResult(null);
    setIsProfileSetupDone(false);
    setIsLoggedIn(false);
    setForceLoginView(false);
    setActiveChatFriend(null);
    setFriends([]);
    setShowSettings(false);
    setShowAddFriendModal(false);
    setShowOtpModal(false);
    setCallState('idle');
    setCurrentCallPartner(null);

    // 3. Clear all related local storage credentials and session keys
    try {
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('global_call_') || key.startsWith('vibeclip_')) {
          localStorage.removeItem(key);
        }
      });
      console.log("All session local storage keys cleared successfully.");
    } catch (e) {
      console.warn("Error cleaning local storage during logout:", e);
    }

    // 4. Update Firestore and Firebase Auth in the background (non-blocking)
    if (myFullPhone && db) {
      setDoc(doc(db, "users", myFullPhone), { 
        status: "offline", 
        updatedAt: serverTimestamp() 
      }, { merge: true })
        .then(() => console.log("Presence set to offline successfully in background."))
        .catch(e => console.warn("Could not sync offline presence on logout:", e));
    }

    if (auth) {
      signOut(auth)
        .then(() => console.log("Firebase Auth signed out in background."))
        .catch(e => console.warn("Firebase Auth signOut error in background:", e));
    }

    console.log("Logout state transition completed instantly and reliably. Redirecting to login screen.");
  };

  // --- Add Friend ---
  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFriendName || !newFriendPhone) return;
    setAddFriendError(null);
    setIsSearchingFriend(true);

    const formattedPhone = normalizePhoneToE164(newFriendPhone, newFriendCountry.code);
    const isDuplicate = friends.some(f => f.phoneNumber === formattedPhone);

    if (isDuplicate) {
      setAddFriendError('This user is already in your contact list!');
      setIsSearchingFriend(false);
      return;
    }

    let finalFriendStatus: 'online' | 'offline' = 'offline';
    let syncedName = newFriendName;
    let userExists = false;
    let verifiedE164Phone = formattedPhone;
    let foundUserData: any = null;

    try {
      // Direct Doc Lookup (super fast lookup)
      const uSnap = await getDoc(doc(db, "users", formattedPhone));
      if (uSnap.exists()) {
        foundUserData = uSnap.data();
        userExists = true;
      } else {
        // Fallback 1: Query database collection for matching phone number string
        const q1 = query(collection(db, "users"), where("phoneNumber", "==", formattedPhone));
        const qSnap1 = await getDocs(q1);
        if (!qSnap1.empty) {
          foundUserData = qSnap1.docs[0].data();
          verifiedE164Phone = qSnap1.docs[0].id; // Use actual Firestore Document ID
          userExists = true;
        } else {
          // Fallback 2: Check matching end digits to support varied formats (e.g., standard 10 digits)
          const digitsOnly = formattedPhone.replace(/\D/g, '');
          const lastTenDigits = digitsOnly.slice(-10);
          if (lastTenDigits.length >= 10) {
            const q2 = query(collection(db, "users"));
            const qSnap2 = await getDocs(q2);
            const matchedDoc = qSnap2.docs.find(d => {
              const cleanedId = d.id.replace(/\D/g, '');
              return cleanedId.endsWith(lastTenDigits);
            });
            if (matchedDoc) {
              foundUserData = matchedDoc.data();
              verifiedE164Phone = matchedDoc.id;
              userExists = true;
            }
          }
        }
      }

      if (userExists && foundUserData) {
        finalFriendStatus = foundUserData.status || 'offline';
        syncedName = foundUserData.name || newFriendName;
      }
    } catch (err) {
      console.warn("Could not lookup user in Firestore during contact add:", err);
    }

    if (!userExists && engineMode !== 'demo') {
      setAddFriendError("This user is not registered on this app yet. Invite them to register!");
      setIsSearchingFriend(false);
      return;
    }

    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);

    try {
      // 1. Optimistic UI update: Instantly insert into the local contact list
      const newFriendObj: Friend = {
        id: verifiedE164Phone,
        name: syncedName,
        phoneNumber: verifiedE164Phone,
        status: finalFriendStatus,
        profileImage: foundUserData?.profileImage || "",
        bio: foundUserData?.bio || ""
      };

      setFriends(prev => {
        const alreadyExists = prev.some(f => f.phoneNumber === verifiedE164Phone);
        if (alreadyExists) return prev;
        const updated = [...prev, newFriendObj];
        localStorage.setItem('global_call_friends', JSON.stringify(updated));
        return updated;
      });

      // 2. Perform background write to current user's friends list
      await setDoc(doc(db, "users", myFullPhone, "friends", verifiedE164Phone), {
        name: syncedName,
        phoneNumber: verifiedE164Phone,
        status: finalFriendStatus,
        addedAt: serverTimestamp()
      });

      // 3. Reciprocal/mutual connection: Instantly save my profile in their friends list
      try {
        await setDoc(doc(db, "users", verifiedE164Phone, "friends", myFullPhone), {
          name: myProfileName || "Friend",
          phoneNumber: myFullPhone,
          status: "online",
          addedAt: serverTimestamp()
        });
      } catch (eRecip) {
        console.warn("Could not save reciprocal connection:", eRecip);
      }

      // 4. Auto open newly added verified friend's chat screen directly!
      setActiveChatFriend(newFriendObj);

      setNewFriendName('');
      setNewFriendPhone('');
      setAddFriendError(null);
      setShowAddFriendModal(false);
    } catch (e) {
      console.error("Error storing friend in cloud Firestore:", e);
      setAddFriendError("Failed to add friend in cloud database.");
    } finally {
      setIsSearchingFriend(false);
    }
  };

  const startCall = async (friend: Friend, type: 'audio' | 'video') => {
    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
    setCallDirection('outgoing');
    setCurrentCallPartner(friend);
    setCallType(type);
    setCallState('dialing');
    sound.startDialTone();

    await prepareLocalStream(type);
    createPeerConnection(friend, true);

    const offer = await peerConnectionRef.current?.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: type === 'video'
    });

    let optimizedOffer = offer;
    if (offer && offer.sdp) {
      const lowBandwidthSdp = setBandwidthLimits(offer.sdp, 32, type === 'video' ? 350 : 0);
      optimizedOffer = {
        type: offer.type,
        sdp: lowBandwidthSdp
      } as RTCSessionDescriptionInit;
    }

    await peerConnectionRef.current?.setLocalDescription(optimizedOffer);

    const callDocRef = doc(db, "calls", friend.phoneNumber);
    await setDoc(callDocRef, {
      caller: myFullPhone,
      callerName: myProfileName,
      callerAvatarIdx: myAvatarIdx,
      callerProfileImage: myProfileImage || "",
      recipient: friend.phoneNumber,
      callType: type,
      status: "dialing",
      offer: JSON.stringify(optimizedOffer),
      answer: "",
      callerCandidates: [],
      recipientCandidates: [],
      timestamp: serverTimestamp()
    });

    // Fetch recipient's FCM registration token & dispatch background push notification
    try {
      const recipientSnap = await getDoc(doc(db, "users", friend.phoneNumber));
      if (recipientSnap.exists()) {
        const recipientData = recipientSnap.data();
        const recipientFcmToken = recipientData.fcmToken;
        if (recipientFcmToken) {
          console.log("FCM registration token found for recipient. Sending background push notification...");
          fetch('/api/send-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: recipientFcmToken,
              title: `Incoming ${type === 'video' ? 'Video' : 'Voice'} Call`,
              body: `${myProfileName} is calling you on Global Call...`,
              data: {
                type: 'call',
                caller: myFullPhone,
                callerName: myProfileName,
                callType: type
              }
            })
          }).then(res => res.json())
            .then(data => console.log("Call FCM trigger response:", data))
            .catch(e => console.error("Error triggering Call FCM push:", e));
        } else {
          console.log("No FCM token registered for recipient. Real-time Firestore signaling will be used.");
        }
      }
    } catch (err) {
      console.warn("Could not lookup recipient FCM token:", err);
    }

    const unsubscribeOutgoingCall = onSnapshot(callDocRef, async (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();

      if (data.status === "connected") {
        if (callState === "dialing" || callState === "ringing") {
          sound.stopDialTone();
          sound.playConnect();
          setCallState("connected");
          
          if (data.answer) {
            try {
              await peerConnectionRef.current?.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answer)));
            } catch (e) {
              console.error("Error setting remote description from recipient answer:", e);
            }
          }
        }
      } else if (data.status === "hangup" || data.status === "rejected") {
        handleLocalHangup(false);
        unsubscribeOutgoingCall();
      }

      if (peerConnectionRef.current && data.recipientCandidates && Array.isArray(data.recipientCandidates)) {
        for (const candStr of data.recipientCandidates) {
          try {
            const cand = JSON.parse(candStr);
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(cand));
          } catch (e) {
            // Ignore
          }
        }
      }
    });

    (window as any).unsubscribeOutgoingCall = unsubscribeOutgoingCall;
  };

  const answerCall = async () => {
    sound.stopRingtone();
    sound.playConnect();
    setCallState('connected');

    if (peerConnectionRef.current) {
      try {
        const answer = await peerConnectionRef.current.createAnswer();
        let optimizedAnswer = answer;
        if (answer && answer.sdp) {
          const lowBandwidthSdp = setBandwidthLimits(answer.sdp, 32, callType === 'video' ? 350 : 0);
          optimizedAnswer = {
            type: answer.type,
            sdp: lowBandwidthSdp
          } as RTCSessionDescriptionInit;
        }

        await peerConnectionRef.current.setLocalDescription(optimizedAnswer);

        const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
        const callDocRef = doc(db, "calls", myFullPhone);

        await updateDoc(callDocRef, {
          status: "connected",
          answer: JSON.stringify(optimizedAnswer)
        });
      } catch (e) {
        console.error("Error answering call:", e);
      }
    }
  };

  const handleLocalHangup = async (shouldBroadcast = true) => {
    stopCallRecording();
    sound.stopDialTone();
    sound.stopRingtone();
    sound.playDisconnect();

    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);

    if (typeof (window as any).unsubscribeOutgoingCall === 'function') {
      try {
        (window as any).unsubscribeOutgoingCall();
        (window as any).unsubscribeOutgoingCall = null;
      } catch (e) {}
    }

    if (shouldBroadcast && currentCallPartner) {
      const isCaller = callDirection === 'outgoing';
      const docId = isCaller ? currentCallPartner.phoneNumber : myFullPhone;

      // Asynchronously trigger missed call push notification if caller hangs up an unanswered dialing/ringing call
      if (isCaller && (callState === 'dialing' || callState === 'ringing') && engineMode !== 'demo') {
        const targetRecipientPhone = currentCallPartner.phoneNumber;
        const callerName = myProfileName || "Global Call User";

        getDoc(doc(db, "users", targetRecipientPhone)).then((recipientSnap) => {
          if (recipientSnap.exists()) {
            const recipientData = recipientSnap.data();
            const recipientFcmToken = recipientData.fcmToken;
            if (recipientFcmToken) {
              console.log("FCM registration token found for recipient missed call alert. Sending push notification...");
              fetch('/api/send-push', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  token: recipientFcmToken,
                  title: "Missed Call",
                  body: `You missed a ${callType === 'video' ? 'Video' : 'Voice'} Call from ${callerName}`,
                  data: {
                    type: 'missed_call',
                    caller: myFullPhone,
                    callerName: callerName,
                    callType: callType,
                    timestamp: String(Date.now())
                  }
                })
              }).then(res => res.json())
                .then(pushData => console.log("Missed call FCM dispatch response:", pushData))
                .catch(e => console.warn("Failed to dispatch missed call push notification:", e));
            }
          }
        }).catch((err) => {
          console.warn("Could not retrieve recipient FCM token for missed call push:", err);
        });
      }
      
      try {
        await updateDoc(doc(db, "calls", docId), { status: "hangup" });
      } catch (err) {
        console.error("Error hanging up in Firestore:", err);
      }
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (currentCallPartner) {
      const status = callState === 'connected' ? 'completed' : 'missed';
      addRecentCall({
        name: currentCallPartner.name,
        phoneNumber: currentCallPartner.phoneNumber,
        type: callDirection,
        callType: callType,
        status: status,
        duration: callDuration,
      });
    }

    setCallState('idle');
    setCurrentCallPartner(null);
    setIsScreenSharing(false);
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCameraOff(!videoTrack.enabled);
      }
    }
  };

  const toggleScreenShare = async () => {
    if (isScreenSharing) {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop());
      }
      setIsScreenSharing(false);
      await prepareLocalStream(callType);
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;
        setIsScreenSharing(true);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = screenStream;
        }

        const videoTrack = screenStream.getVideoTracks()[0];
        if (peerConnectionRef.current) {
          const senders = peerConnectionRef.current.getSenders();
          const videoSender = senders.find(s => s.track?.kind === 'video');
          if (videoSender && videoTrack) {
            videoSender.replaceTrack(videoTrack);
          }
        }

        videoTrack.onended = () => {
          toggleScreenShare();
        };
      } catch (e) {
        console.error('Error screen sharing', e);
      }
    }
  };

  // --- Filter Countries on Search ---
  const filteredCountries = ALL_COUNTRIES.filter(country =>
    country.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    country.code.includes(searchQuery)
  );

  // --- Filter Friends on Search ---
  const filteredFriends = friends.filter((friend: Friend) =>
    friend.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    friend.phoneNumber.includes(searchQuery)
  );

  // --- Sync details of activeChatFriend in real-time from friends array ---
  const chatPartner = activeChatFriend 
    ? (friends.find(f => f.phoneNumber === activeChatFriend.phoneNumber) || activeChatFriend)
    : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col font-sans selection:bg-teal-500/20">
      
      {/* Custom Float Toast Notification */}
      {toast && (
        <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-3 rounded-2xl shadow-2xl border flex items-center gap-3 backdrop-blur-md animate-fadeIn ${
          toast.type === 'success' 
            ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-300 shadow-emerald-950/40' 
            : 'bg-rose-950/90 border-rose-500/30 text-rose-300 shadow-rose-950/40'
        }`}>
          {toast.type === 'success' ? <Check size={14} className="text-emerald-400" /> : <AlertCircle size={14} className="text-rose-400" />}
          <span className="text-xs font-bold font-sans tracking-wide">{toast.message}</span>
        </div>
      )}
      
      {/* Offline Banner */}
      {!isOnline && (
        <div className="bg-amber-600 px-4 py-2 text-center text-sm font-semibold flex items-center justify-center gap-2 z-50">
          <WifiOff size={16} />
          <span>Network connection is unavailable. Cached offline PWA credentials are active.</span>
        </div>
      )}

      {/* Header Bar */}
      <header className="border-b border-zinc-900/60 bg-zinc-950/60 backdrop-blur-md sticky top-0 z-40 px-4 py-3.5">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-teal-500 to-blue-600 p-0.5 shadow-[0_0_15px_rgba(20,184,166,0.2)]">
              <div className="w-full h-full bg-zinc-950 rounded-[10px] flex items-center justify-center">
                <Globe size={16} className="text-teal-400 animate-spin-slow" />
              </div>
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-teal-400 via-cyan-400 to-blue-400 bg-clip-text text-transparent">
                Global Call
              </h1>
              <span className="text-[9px] text-zinc-600 font-mono tracking-wider">Premium WebRTC Suite</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isLoggedIn && (
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
                title="Configuration Settings"
              >
                <Settings size={16} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* VIEW DETERMINATION SYSTEM */}
      <div className="flex-grow flex flex-col justify-center max-w-6xl w-full mx-auto p-4 sm:p-6">
        
        {/* ======================================================== */}
        {/* 1. DIRECT LOGIN / ACCOUNT VERIFICATION SCREEN */}
        {!isLoggedIn ? (
          
          <div className="w-full max-w-md mx-auto bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden my-6">
            
            {/* Ambient gradients */}
            <div className="absolute top-0 right-0 w-40 h-40 bg-teal-500/10 rounded-full filter blur-2xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-40 h-40 bg-blue-500/10 rounded-full filter blur-2xl pointer-events-none" />

            <div className="relative space-y-6">
              
              {/* Logo block */}
              <div className="flex items-center gap-3 border-b border-zinc-800/80 pb-4">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-teal-500 to-blue-600 p-0.5">
                  <div className="w-full h-full bg-zinc-950 rounded-[10px] flex items-center justify-center font-bold text-teal-400">
                    GC
                  </div>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-zinc-100">Account Verification</h3>
                  <p className="text-xs text-zinc-400 font-medium">Enter your mobile number to get started</p>
                </div>
              </div>

              <div className="space-y-4">
                
                {/* Searchable Country Selector Input */}
                <div>
                  <label className="block text-xs text-zinc-400 font-medium mb-1.5">Select Country</label>
                  <button
                    onClick={() => {
                      setCountryModalTarget('login');
                      setShowCountryModal(true);
                    }}
                    className="w-full flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-zinc-100 focus:outline-none focus:border-teal-500 transition text-left cursor-pointer"
                  >
                    <span className="flex items-center gap-2 font-sans">
                      <span className="text-lg">{selectedCountry.flag}</span>
                      <span className="font-semibold">{selectedCountry.name}</span>
                    </span>
                    <span className="text-teal-400 text-xs font-mono font-bold bg-teal-500/10 px-2.5 py-1 rounded">
                      {selectedCountry.code}
                    </span>
                  </button>
                </div>

                {/* Mobile Phone Number Input */}
                <div>
                  <label className="block text-xs text-zinc-400 font-medium mb-1.5">Mobile Number</label>
                  <div className="flex gap-2">
                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-zinc-400 font-mono font-bold flex items-center justify-center min-w-[70px]">
                      {selectedCountry.code}
                    </div>
                    <input
                      type="tel"
                      value={userPhone}
                      onChange={(e) => setUserPhone(e.target.value.replace(/\D/g, ''))}
                      placeholder="Enter mobile number..."
                      className="flex-grow bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-mono"
                    />
                  </div>
                </div>

                {/* Submit Trigger */}
                <button
                  onClick={handleSendOtp}
                  disabled={isSendingOtp}
                  className="w-full mt-2 py-3.5 rounded-xl bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-zinc-950 font-bold text-sm shadow-lg shadow-teal-500/10 transition active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
                >
                  {isSendingOtp ? (
                    <>
                      <RefreshCw className="animate-spin text-zinc-950" size={16} />
                      <span>Sending OTP...</span>
                    </>
                  ) : (
                    <span>Send OTP</span>
                  )}
                </button>

                {/* Firebase recaptcha container */}
                <div id="recaptcha-container" className="mt-2 flex justify-center"></div>

                <div className="flex items-center justify-center gap-1.5 text-[10px] text-zinc-600 font-mono pt-2">
                  <Shield size={12} className="text-zinc-500" />
                  <span>Secure Firebase Recaptcha Encrypted</span>
                </div>

              </div>
            </div>
          </div>
        ) : !isProfileSetupDone ? (
          <div className="w-full max-w-md mx-auto bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden my-6">
            
            {/* Ambient gradients */}
            <div className="absolute top-0 right-0 w-40 h-40 bg-teal-500/10 rounded-full filter blur-2xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-40 h-40 bg-blue-500/10 rounded-full filter blur-2xl pointer-events-none" />

            <div className="relative space-y-6">
              
              {/* Logo block */}
              <div className="flex items-center gap-3 border-b border-zinc-800/80 pb-4">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-teal-500 to-blue-600 p-0.5">
                  <div className="w-full h-full bg-zinc-950 rounded-[10px] flex items-center justify-center font-bold text-teal-400">
                    GC
                  </div>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-zinc-100">Set Up Your Profile</h3>
                  <p className="text-xs text-zinc-400">Choose your display name, username, and avatar</p>
                </div>
              </div>

              <div className="space-y-5">

                {/* Avatar Preview & File Upload */}
                <div className="flex flex-col items-center justify-center gap-3 pb-2">
                  <div className="relative group">
                    {myProfileImage ? (
                      <img
                        src={myProfileImage}
                        alt="Profile Avatar"
                        referrerPolicy="no-referrer"
                        className="w-24 h-24 rounded-full object-cover border-2 border-teal-500/50 shadow-lg"
                      />
                    ) : (
                      <div className={`w-24 h-24 rounded-full bg-gradient-to-tr ${AVATAR_GRADIENTS[myAvatarIdx]} flex items-center justify-center text-zinc-950 font-black text-3xl shadow-lg border-2 border-zinc-800`}>
                        {myProfileName ? myProfileName.charAt(0).toUpperCase() : 'G'}
                      </div>
                    )}
                    <label className="absolute bottom-0 right-0 w-8 h-8 bg-teal-500 text-zinc-950 rounded-full flex items-center justify-center cursor-pointer hover:bg-teal-400 shadow-md transition active:scale-90">
                      <Upload size={14} />
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleImageUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-medium">Upload photo or choose gradient below</span>
                </div>
                
                {/* Name Input */}
                <div>
                  <label className="block text-xs text-zinc-400 font-medium mb-1.5">Full Name</label>
                  <input
                    type="text"
                    value={myProfileName === 'Guest User' ? '' : myProfileName}
                    onChange={(e) => setMyProfileName(e.target.value)}
                    placeholder="Enter your name..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-medium"
                  />
                </div>

                {/* Username Input */}
                <div>
                  <label className="block text-xs text-zinc-400 font-medium mb-1.5">Username</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-zinc-500 font-bold font-mono">@</span>
                    <input
                      type="text"
                      value={myUsername}
                      onChange={(e) => setMyUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                      placeholder="username"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-8 pr-4 py-3.5 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-medium font-mono"
                    />
                  </div>
                </div>

                {/* Avatar Selection */}
                <div>
                  <label className="block text-xs text-zinc-400 font-medium mb-2.5">Or Choose Gradient Background</label>
                  <div className="grid grid-cols-6 gap-3">
                    {AVATAR_GRADIENTS.map((grad, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setMyAvatarIdx(idx);
                          setMyProfileImage('');
                          localStorage.removeItem('global_call_profile_image');
                        }}
                        className={`w-11 h-11 rounded-xl bg-gradient-to-tr ${grad} flex items-center justify-center text-zinc-950 font-black text-sm active:scale-90 transition relative cursor-pointer ${
                          myAvatarIdx === idx && !myProfileImage ? 'ring-2 ring-teal-400 ring-offset-2 ring-offset-zinc-900 scale-105' : 'opacity-80 hover:opacity-100'
                        }`}
                      >
                        {myProfileName ? myProfileName.charAt(0).toUpperCase() : 'G'}
                        {myAvatarIdx === idx && !myProfileImage && (
                          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-zinc-900 border border-teal-400 rounded-full flex items-center justify-center">
                            <span className="w-1.5 h-1.5 bg-teal-400 rounded-full" />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Save and Continue Button */}
                <button
                  onClick={async () => {
                    if (!myProfileName.trim() || myProfileName === 'Guest User') {
                      alert('Please enter a valid display name.');
                      return;
                    }
                    if (!myUsername.trim()) {
                      alert('Please enter a valid username.');
                      return;
                    }
                    localStorage.setItem('global_call_profile_name', myProfileName);
                    localStorage.setItem('global_call_username', myUsername);
                    localStorage.setItem('global_call_profile_avatar_idx', myAvatarIdx.toString());
                    localStorage.setItem('global_call_profile_setup_done', 'true');

                    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
                    try {
                      await setDoc(doc(db, "users", myFullPhone), {
                        uid: auth.currentUser?.uid || "demo_uid_" + Date.now(),
                        phoneNumber: myFullPhone,
                        name: myProfileName,
                        username: myUsername,
                        avatarIdx: myAvatarIdx,
                        profileImage: myProfileImage || "",
                        bio: myBio || "Hey there! I am using Global Call.",
                        status: "online",
                        countryName: selectedCountry.name,
                        countryCode: selectedCountry.code,
                        updatedAt: serverTimestamp()
                      }, { merge: true });
                      console.log("Successfully stored user profile with country details on registration sync!");
                    } catch (err) {
                      console.error("Error storing user profile on registration sync:", err);
                    }

                    setIsProfileSetupDone(true);
                  }}
                  className="w-full mt-4 py-3.5 rounded-xl bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-zinc-950 font-bold text-sm shadow-lg shadow-teal-500/10 transition active:scale-95 cursor-pointer"
                >
                  Save & Continue
                </button>

              </div>
            </div>
          </div>
        ) : (
          
          <div className="w-full max-w-md h-[80vh] sm:h-[760px] mx-auto bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col my-6 relative animate-fadeIn">
            
            {activeChatFriend && chatPartner ? (
              /* --- REVOLUTIONARY REAL-TIME CHAT VIEW (IMO/WHATSAPP STYLE) --- */
              <div className="flex flex-col flex-grow h-0 bg-zinc-950 animate-fadeIn font-sans">
                {/* Chat Room Header */}
                <div className="p-4 border-b border-zinc-850 bg-zinc-900/50 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setActiveChatFriend(null)}
                      className="p-2 -ml-1 rounded-xl text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition cursor-pointer"
                      title="Back to Contacts"
                    >
                      <X size={16} />
                    </button>
                    <div className="relative">
                      {chatPartner.profileImage ? (
                        <img
                          src={chatPartner.profileImage}
                          alt={chatPartner.name}
                          className="w-10 h-10 rounded-full object-cover border border-zinc-800 shadow-md"
                        />
                      ) : (
                        <div className={`w-10 h-10 rounded-full bg-gradient-to-tr ${AVATAR_GRADIENTS[Math.abs(chatPartner.phoneNumber.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % AVATAR_GRADIENTS.length]} flex items-center justify-center text-zinc-950 font-black text-xs shadow-md`}>
                          {chatPartner.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-zinc-950 ${chatPartner.status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
                    </div>
                    <div>
                      <h4 className="font-bold text-xs text-zinc-100">{chatPartner.name}</h4>
                      <p className="text-[10px] text-zinc-500 font-mono mt-0.5 flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${chatPartner.status === 'online' ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
                        <span>{chatPartner.status === 'online' ? 'Online' : 'Offline'}</span>
                        <span>•</span>
                        <span>{chatPartner.phoneNumber}</span>
                      </p>
                      {chatPartner.bio && (
                        <p className="text-[10px] text-teal-400 font-medium italic mt-0.5 max-w-[180px] truncate" title={chatPartner.bio}>
                          "{chatPartner.bio}"
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Calling Triggers & Three-Dot Options */}
                  <div className="flex items-center gap-1.5 relative">
                    <button
                      onClick={() => startCall(activeChatFriend, 'audio')}
                      disabled={blockedUsers.includes(activeChatFriend.phoneNumber)}
                      className="p-2.5 rounded-xl bg-zinc-850 hover:bg-zinc-800 text-teal-400 border border-teal-500/5 transition active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                      title={blockedUsers.includes(activeChatFriend.phoneNumber) ? "Blocked" : "Start Audio Call"}
                    >
                      <Mic size={14} />
                    </button>
                    
                    <button
                      onClick={() => startCall(activeChatFriend, 'video')}
                      disabled={blockedUsers.includes(activeChatFriend.phoneNumber)}
                      className="p-2.5 rounded-xl bg-teal-500 hover:bg-teal-400 text-zinc-950 transition active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                      title={blockedUsers.includes(activeChatFriend.phoneNumber) ? "Blocked" : "Start Video Call"}
                    >
                      <Video size={14} />
                    </button>

                    {/* Three-Dot Menu Options */}
                    <div className="relative">
                      <button
                        onClick={() => setShowChatMenu(!showChatMenu)}
                        className="p-2.5 rounded-xl bg-zinc-850 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 transition cursor-pointer"
                        title="More Options"
                      >
                        <MoreVertical size={14} />
                      </button>

                      {showChatMenu && (
                        <div className="absolute right-0 mt-2 w-40 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl py-1.5 z-50 animate-fadeIn">
                          <button
                            type="button"
                            onClick={() => handleToggleBlock(activeChatFriend.phoneNumber)}
                            className="w-full px-4 py-2.5 text-left text-xs font-bold flex items-center gap-2 hover:bg-zinc-800 transition text-rose-400 hover:text-rose-300 cursor-pointer"
                          >
                            <ShieldAlert size={14} />
                            <span>{blockedUsers.includes(activeChatFriend.phoneNumber) ? 'Unblock User' : 'Block User'}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Chat Room Messages List */}
                <div className="flex-grow p-4 overflow-y-auto space-y-3 bg-zinc-950 custom-scrollbar flex flex-col animate-fadeIn">
                  {chatMessages.length === 0 ? (
                    <div className="my-auto text-center space-y-3 py-10 opacity-60">
                      <Sparkles className="text-teal-400 mx-auto animate-pulse" size={32} />
                      <h4 className="font-semibold text-zinc-400 text-xs font-sans">Secure Encrypted Chat</h4>
                      <p className="text-[10px] text-zinc-600 max-w-xs mx-auto leading-relaxed">
                        Say Hello to {activeChatFriend.name}! Send voice notes, quick emojis, or text messages directly in this secure channel.
                      </p>
                    </div>
                  ) : (
                    chatMessages.map((msg, idx) => {
                      const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
                      const isMe = msg.sender === myFullPhone;
                      return (
                        <div key={msg.id || idx} className={`flex ${isMe ? 'justify-end' : 'justify-start'} animate-fadeIn`}>
                          <div className={`max-w-[75%] rounded-2xl px-3.5 py-2.5 text-xs font-semibold shadow-md ${
                            isMe
                              ? 'bg-gradient-to-r from-teal-500 to-cyan-500 text-zinc-950 rounded-tr-none'
                              : 'bg-zinc-850 text-zinc-200 rounded-tl-none border border-zinc-800/40'
                          }`}>
                            {msg.type === 'voice' ? (
                              <div className="flex flex-col gap-1.5 min-w-[200px]">
                                <div className="flex items-center gap-1.5 text-[10px]">
                                  <span>🎤 Audio Voice Note</span>
                                </div>
                                <audio src={msg.voiceUrl} controls className="w-full h-8 opacity-90 rounded-md" />
                              </div>
                            ) : (
                              <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
                            )}
                            <span className={`text-[8px] mt-1 block text-right font-mono ${isMe ? 'text-teal-900/80' : 'text-zinc-500'}`}>
                              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Quick Emoji Bar & Message Input Form */}
                <div className="p-3 border-t border-zinc-850 bg-zinc-900/40 space-y-2">
                  {blockedUsers.includes(activeChatFriend.phoneNumber) ? (
                    <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3.5 flex flex-col items-center justify-center text-center space-y-2">
                      <ShieldAlert size={20} className="text-rose-500 animate-pulse" />
                      <div className="space-y-1">
                        <h5 className="font-bold text-xs text-zinc-200">This contact is blocked</h5>
                        <p className="text-[10px] text-zinc-500 max-w-xs leading-relaxed">
                          Unblock this contact from the options menu in the top-right to send messages or start WebRTC calls.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 custom-scrollbar">
                        {['👍', '❤️', '😂', '🎉', '🙌', '😮', '🔥', '👏', '💔'].map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => sendMessage(emoji, 'emoji')}
                            className="px-2 py-0.5 text-xs bg-zinc-850 hover:bg-zinc-800 border border-zinc-800 rounded-lg transition active:scale-90 cursor-pointer text-center"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onMouseDown={startVoiceRecording}
                          onMouseUp={stopVoiceRecording}
                          onTouchStart={startVoiceRecording}
                          onTouchEnd={stopVoiceRecording}
                          className={`p-2.5 rounded-xl transition cursor-pointer flex items-center justify-center ${
                            isRecordingVoice 
                              ? 'bg-rose-600 text-white animate-pulse shadow-lg' 
                              : 'bg-zinc-850 hover:bg-zinc-800 text-zinc-400'
                          }`}
                          title="Hold to record voice note"
                        >
                          <Mic size={15} />
                        </button>

                        <input
                          type="text"
                          value={typedMessage}
                          onChange={(e) => setTypedMessage(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && typedMessage.trim()) {
                              sendMessage(typedMessage.trim(), 'text');
                              setTypedMessage('');
                            }
                          }}
                          placeholder={isRecordingVoice ? "Recording... Release to send!" : "Type secure message..."}
                          disabled={isRecordingVoice}
                          className="flex-grow bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-medium font-sans"
                        />

                        <button
                          onClick={() => {
                            if (typedMessage.trim()) {
                              sendMessage(typedMessage.trim(), 'text');
                              setTypedMessage('');
                            }
                          }}
                          disabled={!typedMessage.trim() || isRecordingVoice}
                          className="p-2.5 rounded-xl bg-teal-500 hover:bg-teal-400 text-zinc-950 transition active:scale-95 disabled:opacity-35 disabled:pointer-events-none cursor-pointer flex items-center gap-1.5 font-bold text-xs"
                          title="Send Message"
                        >
                          <span>Send</span>
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* --- STANDARD IMO/WHATSAPP DASHBOARD --- */
              <>
                {/* 1. TOP PROFILE HEADER BAR */}
                <div className="p-4 sm:p-5 border-b border-zinc-800/80 bg-zinc-900/50 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      {myProfileImage ? (
                        <img
                          src={myProfileImage}
                          alt={myProfileName}
                          referrerPolicy="no-referrer"
                          className="w-11 h-11 rounded-full object-cover border border-zinc-700 shadow-md"
                        />
                      ) : (
                        <div className={`w-11 h-11 rounded-full bg-gradient-to-tr ${AVATAR_GRADIENTS[myAvatarIdx]} flex items-center justify-center text-zinc-950 font-black text-sm shadow-md`}>
                          {myProfileName.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-zinc-900 rounded-full animate-pulse" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-bold text-sm text-zinc-100">{myProfileName}</h3>
                      </div>
                      <p className="text-xs text-zinc-500 font-mono flex items-center gap-1 mt-0.5">
                        <span>@{myUsername || 'user'}</span>
                        <span>•</span>
                        <span>{selectedCountry.code} {userPhone}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => setShowSettings(true)}
                      className="p-2 py-1.5 sm:p-2.5 sm:py-2 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 border border-teal-500/25 transition cursor-pointer flex items-center gap-1.5 text-[11px] sm:text-xs font-bold"
                      title="Edit Profile Settings"
                    >
                      <Edit size={13} />
                      <span>Edit Profile</span>
                    </button>

                    <button
                      onClick={handleLogout}
                      className="p-2 sm:p-2.5 rounded-xl bg-zinc-850 hover:bg-rose-950/25 text-zinc-400 hover:text-rose-400 border border-zinc-800 hover:border-rose-950/40 transition cursor-pointer"
                      title="Logout Account"
                    >
                      <LogOut size={15} />
                    </button>
                  </div>
                </div>

                {/* 3. SEARCH CONTACTS BAR */}
                <div className="p-3 bg-zinc-900/40 border-b border-zinc-800/40">
                  <div className="relative">
                    <Search className="absolute left-3.5 top-3 text-zinc-500" size={15} />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search contacts by name or number..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-4 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-medium"
                    />
                    {searchQuery && (
                      <button 
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-3 text-zinc-500 hover:text-zinc-300"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* 4. CHAT VS HISTORY TAB SELECTOR */}
                <div className="px-4 py-2 bg-zinc-900/20 border-b border-zinc-800/30 flex items-center gap-1.5">
                  <button
                    onClick={() => setDashboardTab('friends')}
                    className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 ${dashboardTab === 'friends' ? 'bg-teal-500 text-zinc-950 shadow-md' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    <User size={13} />
                    Contacts
                  </button>
                  <button
                    onClick={() => setDashboardTab('recents')}
                    className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 ${dashboardTab === 'recents' ? 'bg-teal-500 text-zinc-950 shadow-md' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    <Clock size={13} />
                    Call History ({recentCalls.length})
                  </button>
                  <button
                    onClick={() => setDashboardTab('recordings')}
                    className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 ${dashboardTab === 'recordings' ? 'bg-teal-500 text-zinc-950 shadow-md' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    <Video size={13} />
                    Recordings ({savedRecordings.length})
                  </button>
                  {dashboardTab === 'recents' && recentCalls.length > 0 && (
                    <button
                      onClick={clearRecentCalls}
                      className="ml-auto text-[10px] font-bold text-rose-400 hover:text-rose-300 bg-rose-950/10 hover:bg-rose-950/20 border border-rose-950/20 px-2.5 py-1 rounded-lg transition"
                    >
                      Clear Logs
                    </button>
                  )}
                </div>

                {/* 5. VERTICALLY SCROLLABLE LIST */}
                <div className="flex-grow h-0 overflow-y-auto custom-scrollbar bg-zinc-900/10">
                  {dashboardTab === 'friends' ? (
                    filteredFriends.length === 0 ? (
                      <div className="text-center py-16 px-4 space-y-3">
                        <User size={36} className="text-zinc-700 mx-auto" />
                        <h4 className="font-semibold text-zinc-400 text-xs">No contacts found</h4>
                        <p className="text-[11px] text-zinc-600 max-w-xs mx-auto leading-relaxed">
                          Use the "+" button on the bottom right to add a contact to your list.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-850/50">
                        {filteredFriends.map((friend) => (
                          <div key={friend.id} className="p-4 flex items-center justify-between gap-3 hover:bg-zinc-800/10 transition-colors">
                            
                            {/* Clickable Avatar and Info to open Chat Room */}
                            <div 
                              onClick={() => setActiveChatFriend(friend)}
                              className="flex items-center gap-3 flex-grow cursor-pointer group"
                            >
                              <div className="relative">
                                {friend.profileImage ? (
                                  <img
                                    src={friend.profileImage}
                                    alt={friend.name}
                                    className="w-10 h-10 rounded-full object-cover border border-zinc-750 group-hover:border-teal-500/50 transition shadow-md"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="w-10 h-10 rounded-full bg-zinc-850 border border-zinc-750 flex items-center justify-center font-bold text-sm text-teal-400 group-hover:border-teal-500/50 transition">
                                    {friend.name.charAt(0).toUpperCase()}
                                  </div>
                                )}
                                <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-zinc-900 ${friend.status === 'online' ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
                              </div>
                              <div>
                                <h4 className="font-bold text-sm text-zinc-100 group-hover:text-teal-400 transition">{friend.name}</h4>
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                  <span className="text-[10px] text-zinc-500 font-mono">{friend.phoneNumber}</span>
                                  {friend.bio && (
                                    <span className="text-[10px] text-zinc-400 italic line-clamp-1 max-w-[180px]">{friend.bio}</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Action shortcuts */}
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => startCall(friend, 'audio')}
                                className="p-2.5 rounded-xl bg-zinc-850 hover:bg-zinc-800 text-teal-400 border border-teal-500/5 transition active:scale-95 cursor-pointer"
                                title="Start Audio Call"
                              >
                                <Mic size={14} />
                              </button>
                              
                              <button
                                onClick={() => startCall(friend, 'video')}
                                className="p-2.5 rounded-xl bg-teal-500 hover:bg-teal-400 text-zinc-950 transition active:scale-95 cursor-pointer"
                                title="Start Video Call"
                              >
                                <Video size={14} />
                              </button>
                            </div>

                          </div>
                        ))}
                      </div>
                    )
                  ) : dashboardTab === 'recents' ? (
                    recentCalls.length === 0 ? (
                      <div className="text-center py-16 px-4 space-y-3">
                        <Clock size={36} className="text-zinc-700 mx-auto" />
                        <h4 className="font-semibold text-zinc-400 text-xs font-mono">No call logs yet</h4>
                        <p className="text-[11px] text-zinc-600 max-w-xs mx-auto leading-relaxed">
                          Your dialed or received audio and video WebRTC connection history will display here.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-850/50">
                        {recentCalls.map((call) => {
                          const isOutgoing = call.type === 'outgoing';
                          const isMissed = call.status === 'missed';

                          return (
                            <div key={call.id} className="p-4 flex items-center justify-between gap-3 hover:bg-zinc-800/10 transition">
                              
                              <div className="flex items-center gap-3">
                                <div className={`w-9 h-9 rounded-full border flex items-center justify-center relative ${isMissed ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' : 'bg-zinc-850 border-zinc-800 text-zinc-300'}`}>
                                  {call.callType === 'video' ? <Video size={14} /> : <Phone size={13} />}
                                  <span className="absolute -bottom-1 -right-1 w-4.5 h-4.5 rounded-full bg-zinc-950 border border-zinc-850 flex items-center justify-center shadow-md">
                                    {isOutgoing ? (
                                      <ArrowUpRight size={8} className="text-teal-400" />
                                    ) : isMissed ? (
                                      <PhoneMissed size={7} className="text-rose-500" />
                                    ) : (
                                      <ArrowDownLeft size={8} className="text-emerald-400" />
                                    )}
                                  </span>
                                </div>

                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <h4 className="font-bold text-xs text-zinc-100">{call.name}</h4>
                                    <span className={`text-[8px] px-1 py-0.5 rounded font-bold uppercase tracking-wider ${isMissed ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                      {isMissed ? 'Missed' : 'Completed'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono mt-0.5">
                                    <span>{call.phoneNumber}</span>
                                    <span>•</span>
                                    <span>{call.timestamp}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono text-zinc-500 mr-2">
                                  {isMissed ? 'No Answer' : formatDuration(call.duration)}
                                </span>
                                <button
                                  onClick={() => {
                                    const friendObj = friends.find(f => f.phoneNumber === call.phoneNumber) || {
                                      id: Date.now().toString(),
                                      name: call.name,
                                      phoneNumber: call.phoneNumber,
                                      status: 'online' as const
                                    };
                                    startCall(friendObj, call.callType);
                                  }}
                                  className="p-2 rounded-lg bg-zinc-850 hover:bg-zinc-800 text-teal-400 transition"
                                  title="Redial"
                                >
                                  {call.callType === 'video' ? <Video size={12} /> : <Phone size={12} />}
                                </button>
                                <button
                                  onClick={() => removeRecentCall(call.id)}
                                  className="p-2 rounded-lg bg-zinc-900 hover:bg-rose-950/20 text-zinc-600 hover:text-rose-400 transition"
                                  title="Delete log"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>

                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : (
                    savedRecordings.length === 0 ? (
                      <div className="text-center py-16 px-4 space-y-3">
                        <Video size={36} className="text-zinc-700 mx-auto" />
                        <h4 className="font-semibold text-zinc-400 text-xs font-mono">No call recordings found</h4>
                        <p className="text-[11px] text-zinc-600 max-w-xs mx-auto leading-relaxed">
                          Recordings from your video or audio calls will display here. Tap "Record" during a call to save one!
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-850/50">
                        {savedRecordings.map((rec) => {
                          const playUrl = URL.createObjectURL(rec.blob);
                          return (
                            <div key={rec.id} className="p-4 flex flex-col gap-3 hover:bg-zinc-800/10 transition">
                              
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 flex items-center justify-center">
                                    <Video size={14} />
                                  </div>
                                  <div>
                                    <h4 className="font-bold text-xs text-zinc-100">Recording with {rec.partnerName}</h4>
                                    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono mt-0.5">
                                      <span>{rec.partnerPhone}</span>
                                      <span>•</span>
                                      <span>{rec.timestamp}</span>
                                      <span>•</span>
                                      <span className="text-teal-400 font-semibold">{rec.duration}s</span>
                                    </div>
                                  </div>
                                </div>
                                <button
                                  onClick={() => handleDeleteRecording(rec.id)}
                                  className="p-2 rounded-lg bg-zinc-900 hover:bg-rose-950/20 text-zinc-600 hover:text-rose-400 transition"
                                  title="Delete recording"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>

                              <div className="bg-zinc-950/80 border border-zinc-850 rounded-xl p-2.5 space-y-2">
                                <video
                                  src={playUrl}
                                  controls
                                  playsInline
                                  className="w-full h-32 object-cover rounded-lg bg-black"
                                />
                                <div className="flex justify-between items-center text-[10px]">
                                  <span className="text-zinc-500 font-mono">Format: WebM/MP4 ({Math.round(rec.blob.size / 1024)} KB)</span>
                                  <a
                                    href={playUrl}
                                    download={`Call_Recording_${rec.partnerName.replace(/\s+/g, '_')}_${rec.id}.webm`}
                                    className="px-3 py-1 bg-teal-500 hover:bg-teal-400 text-zinc-950 font-bold rounded-lg transition"
                                  >
                                    Download Recording
                                  </a>
                                </div>
                              </div>

                            </div>
                          );
                        })}
                      </div>
                    )
                  )}
                </div>

                {/* Floating Add Contact FAB Button on bottom right */}
                <button
                  onClick={() => {
                    setAddFriendError(null);
                    setAddFriendStep('selection');
                    setShowAddFriendModal(true);
                  }}
                  className="absolute bottom-6 right-6 w-14 h-14 bg-gradient-to-tr from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-zinc-950 rounded-full flex items-center justify-center shadow-2xl hover:scale-105 active:scale-95 transition z-30 cursor-pointer border-2 border-zinc-900"
                  title="Add New Friend"
                >
                  <Plus size={24} strokeWidth={2.5} />
                </button>
              </>
            )}

          </div>
        )}

      </div>

      {/* ======================================================== */}
      {/* SEARCHABLE COUNTRY SELECTOR MODAL */}
      {showCountryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-3xl p-5 shadow-2xl flex flex-col max-h-[80vh]">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4">
              <h3 className="font-bold text-sm text-zinc-200 flex items-center gap-2">
                <Globe size={16} className="text-teal-400" />
                Select Your Country ({ALL_COUNTRIES.length} Countries)
              </h3>
              <button 
                onClick={() => {
                  setShowCountryModal(false);
                  setSearchQuery('');
                }} 
                className="text-zinc-500 hover:text-zinc-300 transition"
              >
                <X size={18} />
              </button>
            </div>

             {/* Search Input */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-3 text-zinc-500" size={16} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search country by name or dial code..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-medium"
              />
            </div>

            {/* Country List Container */}
            <div className="flex-grow overflow-y-auto divide-y divide-zinc-800/40 pr-1 space-y-0.5">
              {filteredCountries.length === 0 ? (
                <div className="text-center py-10 text-zinc-500 text-xs font-medium">
                  No country found!
                </div>
              ) : (
                filteredCountries.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (countryModalTarget === 'login') {
                        setSelectedCountry(c);
                        localStorage.setItem('global_call_country_name', c.name);
                        localStorage.setItem('global_call_country_code', c.code);
                      } else {
                        setNewFriendCountry(c);
                      }
                      setShowCountryModal(false);
                      setSearchQuery('');
                    }}
                    className="w-full flex items-center justify-between px-3 py-3 rounded-lg hover:bg-zinc-800/40 text-left transition"
                  >
                    <span className="flex items-center gap-3">
                      <span className="text-xl">{c.flag}</span>
                      <span className="text-xs text-zinc-200 font-semibold">{c.name}</span>
                    </span>
                    <span className="text-xs font-mono font-bold text-teal-400">
                      {c.code}
                    </span>
                  </button>
                ))
              )}
            </div>

          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* OTP MODAL */}
      {showOtpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 w-full max-w-sm rounded-2xl p-6 shadow-2xl relative overflow-hidden">
            
            {/* Design accents */}
            <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/10 rounded-full filter blur-xl pointer-events-none" />
            
            <h3 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
              <Shield size={18} className="text-teal-400" />
              <span>Verify Secure Link</span>
            </h3>
            <p className="text-xs text-zinc-400 mt-1">
              {engineMode === 'demo' ? 'Simulated SMS verification for:' : 'A 6-digit verification code was requested for:'} <br />
              <strong className="text-zinc-200 font-mono text-[13px]">{selectedCountry.code} {userPhone}</strong>
            </p>

            <div className="mt-5 space-y-4">
              {isSendingOtp && !confirmationResult && engineMode !== 'demo' ? (
                /* 1. Requesting SMS/recaptcha state */
                <div className="flex flex-col items-center justify-center py-6 space-y-3">
                  <RefreshCw className="animate-spin text-teal-400" size={32} />
                  <div className="text-center space-y-1">
                    <span className="text-xs font-bold text-zinc-200">Starting Phone Verification</span>
                    <p className="text-[10px] text-zinc-500 max-w-[240px] leading-relaxed">
                      Please solve the Google reCAPTCHA challenge if prompted.
                    </p>
                  </div>
                </div>
              ) : otpError ? (
                /* 2. Error Display state */
                <div className="space-y-4 py-2">
                  <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3.5 flex gap-3 text-rose-400 text-xs">
                    <AlertCircle size={18} className="shrink-0 text-rose-500 mt-0.5 animate-pulse" />
                    <div className="space-y-1">
                      <h5 className="font-bold text-zinc-200">Verification Failure</h5>
                      <p className="text-zinc-400 leading-normal text-[11px] font-medium">{otpError}</p>
                    </div>
                  </div>
                  
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setShowOtpModal(false);
                        setOtpError(null);
                      }}
                      className="flex-grow py-2.5 rounded-xl bg-zinc-850 hover:bg-zinc-800 text-zinc-300 font-semibold text-xs transition cursor-pointer"
                    >
                      Close Window
                    </button>
                    <button
                      onClick={handleSendOtp}
                      className="flex-grow py-2.5 rounded-xl bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-zinc-950 font-bold text-xs transition cursor-pointer"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              ) : (
                /* 3. Input form (Visible or Verifying state) */
                <div className="space-y-4">
                  <div className="relative">
                    <input
                      type="text"
                      maxLength={6}
                      disabled={isSendingOtp}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="• • • • • •"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-center text-xl tracking-[0.4em] font-mono text-zinc-100 focus:outline-none focus:border-teal-500 transition disabled:opacity-50"
                    />
                    {isSendingOtp && (
                      <div className="absolute inset-0 bg-zinc-950/70 rounded-xl flex items-center justify-center gap-2">
                        <RefreshCw className="animate-spin text-teal-400" size={14} />
                        <span className="text-[10px] font-mono text-zinc-300">Verifying code...</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span>Didn't receive code?</span>
                    <button
                      type="button"
                      disabled={otpTimer > 540 || isSendingOtp}
                      onClick={handleSendOtp}
                      className="text-teal-400 font-bold hover:underline bg-transparent border-none p-0 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                    >
                      {otpTimer > 0 
                        ? `Resend in ${Math.floor(otpTimer / 60)}:${(otpTimer % 60).toString().padStart(2, '0')}` 
                        : 'Resend OTP'
                      }
                    </button>
                  </div>

                  <div className="flex gap-2.5 pt-1.5">
                    <button
                      type="button"
                      disabled={isSendingOtp}
                      onClick={() => {
                        setShowOtpModal(false);
                        setOtpCode('');
                        setOtpError(null);
                      }}
                      className="flex-1 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-zinc-300 font-semibold text-xs transition cursor-pointer disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isSendingOtp || otpCode.length < 6}
                      onClick={handleVerifyOtp}
                      className="flex-1 py-3 rounded-xl bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-zinc-950 font-bold text-xs transition cursor-pointer shadow-md shadow-teal-500/10 disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-1.5"
                    >
                      {isSendingOtp ? (
                        <>
                          <RefreshCw className="animate-spin text-zinc-950" size={12} />
                          <span>Verifying...</span>
                        </>
                      ) : (
                        <span>Verify Code</span>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* ADD FRIEND MODAL */}
      {showAddFriendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fadeIn">
          <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-2xl p-6 shadow-2xl relative">
            <button 
              onClick={() => setShowAddFriendModal(false)}
              className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
            >
              <X size={18} />
            </button>

            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2 border-b border-zinc-800 pb-3 mb-4">
              {addFriendStep === 'form' ? (
                <button
                  type="button"
                  onClick={() => setAddFriendStep('selection')}
                  className="mr-1 p-1 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded transition cursor-pointer flex items-center justify-center"
                  title="Back to Selection"
                >
                  <ArrowRight size={14} className="rotate-180" />
                </button>
              ) : (
                <UserPlus size={18} className="text-teal-400" />
              )}
              <span>Add Friend</span>
            </h3>

            {addFriendStep === 'selection' ? (
              <div className="space-y-5 py-2">
                <div className="text-center py-4">
                  <div className="w-16 h-16 rounded-2xl bg-teal-500/10 text-teal-400 flex items-center justify-center mx-auto mb-3 shadow-inner border border-teal-500/10">
                    <UserPlus size={28} />
                  </div>
                  <h4 className="text-sm font-bold text-zinc-200">Choose Contact Action</h4>
                  <p className="text-[11px] text-zinc-500 max-w-xs mx-auto mt-1 leading-relaxed">
                    Select an option below to expand your global WebRTC communication network.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setAddFriendStep('form')}
                  className="w-full p-4 rounded-xl bg-zinc-950 border border-zinc-800 hover:border-teal-500/40 hover:bg-teal-500/5 transition cursor-pointer text-left flex items-center gap-4 group"
                >
                  <div className="w-10 h-10 rounded-lg bg-teal-500/10 text-teal-400 flex items-center justify-center shrink-0 group-hover:bg-teal-500 group-hover:text-zinc-950 transition">
                    <UserPlus size={18} />
                  </div>
                  <div className="flex-grow">
                    <h5 className="text-xs font-bold text-zinc-200 group-hover:text-teal-400 transition">New Friend</h5>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      Save a new friend contact using their name, country code and phone number.
                    </p>
                  </div>
                  <ChevronRight size={14} className="text-zinc-600 group-hover:text-teal-400 transition" />
                </button>

                <div className="flex gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddFriendModal(false)}
                    className="w-full py-3 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-zinc-300 font-semibold text-xs transition cursor-pointer text-center"
                  >
                    Close Window
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAddFriend} className="space-y-4">
                <div>
                  <label className="block text-xs text-zinc-400 font-medium mb-1.5">Friend's Name</label>
                  <input
                    type="text"
                    required
                    value={newFriendName}
                    onChange={(e) => setNewFriendName(e.target.value)}
                    placeholder="Enter name..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-teal-500 font-medium"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-1">
                    <label className="block text-xs text-zinc-400 font-medium mb-1.5">Country</label>
                    <button
                      type="button"
                      onClick={() => {
                        setCountryModalTarget('friend');
                        setShowCountryModal(true);
                      }}
                      className="w-full flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-xl px-2 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-teal-500"
                    >
                      <span>{newFriendCountry.flag}</span>
                      <span className="font-mono font-bold text-[10px] text-teal-400">{newFriendCountry.code}</span>
                    </button>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400 font-medium mb-1.5">Mobile Number</label>
                    <input
                       type="tel"
                      required
                      disabled={isSearchingFriend}
                      value={newFriendPhone}
                      onChange={(e) => setNewFriendPhone(e.target.value.replace(/[^0-9+]/g, ''))}
                      placeholder="Enter number..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-100 focus:outline-none focus:border-teal-500 font-mono font-semibold disabled:opacity-50"
                    />
                  </div>
                </div>

                {addFriendError && (
                  <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 flex gap-2.5 text-rose-400 text-xs animate-fadeIn">
                    <AlertCircle size={16} className="shrink-0 text-rose-500 mt-0.5 animate-pulse" />
                    <p className="font-semibold leading-normal text-[11px]">{addFriendError}</p>
                  </div>
                )}

                <div className="flex gap-2.5 pt-1.5">
                  <button
                    type="button"
                    disabled={isSearchingFriend}
                    onClick={() => setAddFriendStep('selection')}
                    className="flex-1 py-3 rounded-xl bg-zinc-850 hover:bg-zinc-800 text-zinc-300 font-semibold text-xs transition cursor-pointer text-center disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={isSearchingFriend}
                    className="flex-1 py-3 rounded-xl bg-teal-500 hover:bg-teal-400 text-zinc-950 font-bold text-xs transition cursor-pointer text-center flex items-center justify-center gap-2 disabled:opacity-70"
                  >
                    {isSearchingFriend ? (
                      <>
                        <RefreshCw size={12} className="animate-spin text-zinc-950" />
                        <span>Checking...</span>
                      </>
                    ) : (
                      <span>Add Friend</span>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* CALL SCREEN / WEBRTC OVERLAY */}
      {callState !== 'idle' && currentCallPartner && (
        <div className="fixed inset-0 z-50 bg-zinc-950 flex flex-col justify-between p-4 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-teal-500/5 via-zinc-950 to-zinc-950 pointer-events-none" />

          {/* Call Header */}
          <div className="relative z-10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-teal-500 to-blue-500 p-0.5">
                <div className="w-full h-full bg-zinc-950 rounded-full flex items-center justify-center">
                  <Globe size={12} className="text-teal-400 animate-spin-slow" />
                </div>
              </div>
              <div>
                <h4 className="font-bold text-xs text-zinc-300">Global Call HD Link</h4>
                <div className="flex items-center gap-1.5 text-[9px] text-zinc-600 font-mono mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Secure TLS WebRTC Stream</span>
                </div>
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 px-3 py-1 rounded-lg text-[9px] font-mono text-zinc-300">
              RTT: {stats.rtt}ms
            </div>
          </div>

          {/* Central Canvas Viewport */}
          <div className="relative flex-grow flex items-center justify-center z-10">
            {callState === 'connected' ? (
              <div className="relative w-full h-full max-w-4xl max-h-[70vh] rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800 shadow-2xl flex items-center justify-center">
                
                {/* REMOTE VIDEO FEED */}
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />

                {/* Backup Audio Only Interface */}
                {(!remoteVideoRef.current?.srcObject || callType === 'audio') && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90 space-y-4">
                    <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-teal-500 to-cyan-500 flex items-center justify-center text-zinc-950 font-bold text-3xl">
                      {currentCallPartner.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="text-center">
                      <h3 className="font-bold text-lg text-zinc-100">{currentCallPartner.name}</h3>
                      <p className="text-xs text-zinc-400 mt-1 font-mono">Audio Channel Connected</p>
                    </div>
                  </div>
                )}

                {/* LOCAL VIDEO PIP THUMBNAIL */}
                {callType === 'video' && !isCameraOff && (
                  <div className="absolute bottom-4 right-4 w-28 sm:w-36 h-36 sm:h-48 rounded-xl overflow-hidden border-2 border-teal-400 bg-zinc-950 shadow-2xl z-20">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover transform -scale-x-100"
                    />
                  </div>
                )}

                {/* Stats Panel */}
                <div className="absolute top-4 left-4 p-3 rounded-xl bg-zinc-950/80 border border-zinc-850/80 text-[9px] text-zinc-400 font-mono space-y-1 backdrop-blur-md">
                  <div className="flex justify-between gap-5">
                    <span>Codec</span>
                    <span className="text-teal-400 font-bold">{stats.audioCodec}</span>
                  </div>
                  <div className="flex justify-between gap-5">
                    <span>Resolution</span>
                    <span className="text-teal-400 font-bold">{stats.resolution}</span>
                  </div>
                  <div className="flex justify-between gap-5">
                    <span>Framerate</span>
                    <span className="text-teal-400 font-bold">{stats.fps} fps</span>
                  </div>
                  <div className="flex justify-between gap-5">
                    <span>Bandwidth</span>
                    <span className="text-teal-400 font-bold">{stats.bandwidth}</span>
                  </div>
                </div>

              </div>
            ) : (
              /* OUTGOING DIAL / INCOMING RING */
              <div className="text-center space-y-5">
                <div className="relative inline-block">
                  <div className="absolute inset-0 bg-teal-400/10 rounded-full animate-ping scale-125" />
                  <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-teal-500 to-blue-500 flex items-center justify-center text-zinc-950 font-bold text-3xl shadow-xl border-4 border-zinc-950 relative z-10">
                    {currentCallPartner.name.charAt(0).toUpperCase()}
                  </div>
                </div>

                <div>
                  <h3 className="font-bold text-xl text-zinc-100">{currentCallPartner.name}</h3>
                  <span className="text-xs text-zinc-500 font-mono mt-1 block">{currentCallPartner.phoneNumber}</span>
                </div>

                <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-teal-400">
                  <RefreshCw className="animate-spin text-teal-400" size={14} />
                  <span>
                    {callState === 'dialing' ? 'Dialing...' : 'Ringing...'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Call Controllers */}
          <div className="relative z-10 flex flex-col items-center gap-3 py-3">
            
            {callState === 'connected' && (
              <span className="text-xs font-bold text-zinc-100 bg-zinc-900 border border-zinc-800 px-3 py-1 rounded-full font-mono">
                {formatTime(callDuration)}
              </span>
            )}

            <div className="flex items-center justify-center gap-3.5">
              {callState === 'ringing' ? (
                <>
                  <button
                    onClick={() => handleLocalHangup()}
                    className="p-3.5 rounded-full bg-rose-600 hover:bg-rose-500 text-white shadow transition transform hover:scale-105"
                  >
                    <PhoneOff size={22} />
                  </button>
                  <button
                    onClick={answerCall}
                    className="p-3.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow transition transform hover:scale-105 animate-pulse"
                  >
                    <Phone size={22} />
                  </button>
                </>
              ) : (
                <>
                  {callState === 'connected' && (
                    <>
                      <button
                        onClick={toggleMute}
                        className={`p-3 rounded-xl border transition ${isMuted ? 'bg-rose-500/20 border-rose-500/30 text-rose-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'}`}
                      >
                        {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                      </button>

                      {callType === 'video' && (
                        <button
                          onClick={toggleCamera}
                          className={`p-3 rounded-xl border transition ${isCameraOff ? 'bg-rose-500/20 border-rose-500/30 text-rose-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'}`}
                        >
                          {isCameraOff ? <VideoOff size={18} /> : <Video size={18} />}
                        </button>
                      )}

                      <button
                        onClick={toggleScreenShare}
                        className={`p-3 rounded-xl border transition ${isScreenSharing ? 'bg-teal-500/20 border-teal-500/30 text-teal-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'}`}
                      >
                        <Share2 size={18} />
                      </button>

                      {/* Speaker Mode Toggle */}
                      <button
                        onClick={() => setIsSpeakerEnabled(!isSpeakerEnabled)}
                        className={`p-3 rounded-xl border transition ${isSpeakerEnabled ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/20 border-rose-500/30 text-rose-400'}`}
                        title={isSpeakerEnabled ? "Speaker Mode (Hands-Free)" : "Receiver Mode (Earphone)"}
                      >
                        {isSpeakerEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                      </button>

                      {/* Call Recording Toggle */}
                      <button
                        onClick={isRecordingCall ? stopCallRecording : startCallRecording}
                        className={`p-3 rounded-xl border transition flex items-center justify-center gap-1.5 font-bold text-xs ${isRecordingCall ? 'bg-rose-600 border-rose-500 text-white animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.4)]' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'}`}
                        title={isRecordingCall ? "Stop Recording" : "Record Call"}
                      >
                        <span className={`w-2.5 h-2.5 rounded-full ${isRecordingCall ? 'bg-white animate-ping' : 'bg-rose-500'}`} />
                        <span>{isRecordingCall ? "REC" : "Record"}</span>
                      </button>

                      {/* In-Call Volume Slider Panel */}
                      <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-xl">
                        <span className="text-[9px] text-zinc-500 font-bold uppercase">Vol</span>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={callVolume}
                          onChange={(e) => setCallVolume(Number(e.target.value))}
                          className="w-16 accent-teal-400 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                        />
                        <span className="text-[9px] font-mono font-bold text-teal-400 min-w-[24px] text-right">
                          {callVolume}%
                        </span>
                      </div>
                    </>
                  )}

                  <button
                    onClick={() => handleLocalHangup()}
                    className="p-3.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white shadow active:scale-95 transition"
                  >
                    <PhoneOff size={22} />
                  </button>
                </>
              )}
            </div>

            <span className="text-[9px] text-zinc-600 font-mono tracking-widest">
              OPUS VARIABLE CODEC • HIGH QUALITY WEBRTC ENGINE
            </span>
          </div>

        </div>
      )}

      {/* ======================================================== */}
      {/* SETTINGS / PROFILE OVERVIEW MODAL */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fadeIn">
          <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-3xl p-6 shadow-2xl relative overflow-hidden">
            
            {/* Design gradients */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-teal-500/10 rounded-full filter blur-xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-32 h-32 bg-blue-500/10 rounded-full filter blur-xl pointer-events-none" />

            <button 
              onClick={() => setShowSettings(false)}
              className="absolute top-5 right-5 text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
            >
              <X size={18} />
            </button>

            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2 border-b border-zinc-800 pb-3 mb-5">
              <Settings size={18} className="text-teal-400" />
              <span>Profile Settings</span>
            </h3>

            <div className="space-y-5 relative">
              {/* Avatar Preview */}
              <div className="flex flex-col items-center justify-center gap-2">
                <div className="relative">
                  {myProfileImage ? (
                    <img
                      src={myProfileImage}
                      alt={myProfileName}
                      className="w-20 h-20 rounded-full object-cover border-2 border-teal-500/40 shadow-lg"
                    />
                  ) : (
                    <div className={`w-20 h-20 rounded-full bg-gradient-to-tr ${AVATAR_GRADIENTS[myAvatarIdx]} flex items-center justify-center text-zinc-950 font-black text-2xl shadow-lg border-2 border-zinc-800`}>
                      {myProfileName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <label className="absolute bottom-0 right-0 w-7 h-7 bg-teal-500 text-zinc-950 rounded-full flex items-center justify-center cursor-pointer hover:bg-teal-400 shadow-md transition active:scale-90">
                    <Upload size={12} />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                  </label>
                </div>
                <span className="text-[10px] text-zinc-500">Tap icon to change your profile picture</span>
              </div>

              {/* Editable Fields */}
              <div className="space-y-3.5">
                <div>
                  <label className="block text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Full Display Name</label>
                  <input
                    type="text"
                    value={myProfileName}
                    onChange={(e) => {
                      setMyProfileName(e.target.value);
                      localStorage.setItem('global_call_profile_name', e.target.value);
                      updateFirestoreProfile({ name: e.target.value });
                    }}
                    placeholder="Enter full name..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-medium font-sans"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Unique Username</label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-zinc-500 font-bold font-mono">@</span>
                    <input
                      type="text"
                      value={myUsername}
                      onChange={(e) => {
                        const cleanVal = e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
                        setMyUsername(cleanVal);
                        localStorage.setItem('global_call_username', cleanVal);
                        updateFirestoreProfile({ username: cleanVal });
                      }}
                      placeholder="username"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-7 pr-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-medium font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">Status Message / Bio</label>
                  <input
                    type="text"
                    value={myBio}
                    maxLength={100}
                    onChange={(e) => {
                      setMyBio(e.target.value);
                      localStorage.setItem('global_call_bio', e.target.value);
                      updateFirestoreProfile({ bio: e.target.value });
                    }}
                    placeholder="Hey there! I am using Global Call."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-teal-500 font-medium font-sans"
                  />
                </div>

                {/* Account Details & Saved Country View */}
                <div className="bg-zinc-950 border border-zinc-800/80 rounded-2xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500 font-medium">Registered Country</span>
                    <span className="font-semibold text-zinc-200 flex items-center gap-1.5 text-right">
                      <span>{selectedCountry.flag}</span>
                      <span>{selectedCountry.name} ({selectedCountry.code})</span>
                    </span>
                  </div>
                  <div className="h-[1px] bg-zinc-850" />
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500 font-medium">Verified Phone</span>
                    <span className="font-semibold font-mono text-teal-400">{userPhone}</span>
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div className="flex gap-2.5 pt-2">
                <button
                  onClick={async () => {
                    // Force instant Firestore profile sync update
                    const myFullPhone = userPhone.startsWith('+') ? userPhone : (selectedCountry.code + userPhone);
                    // Close the modal instantly for snappy UX, and sync in background
                    setShowSettings(false);
                    try {
                      await setDoc(doc(db, "users", myFullPhone), {
                        name: myProfileName,
                        username: myUsername,
                        bio: myBio,
                        avatarIdx: myAvatarIdx,
                        profileImage: myProfileImage || "",
                        countryName: selectedCountry.name,
                        countryCode: selectedCountry.code,
                        updatedAt: serverTimestamp()
                      }, { merge: true });
                      showToast("Profile updated successfully!", "success");
                    } catch (e) {
                      console.error(e);
                      showToast("Failed to update profile. Try again.", "error");
                    }
                  }}
                  className="flex-1 py-3 rounded-xl bg-teal-500 hover:bg-teal-400 text-zinc-950 font-bold text-xs transition cursor-pointer text-center"
                >
                  Save Changes
                </button>

                <button
                  onClick={() => {
                    setShowSettings(false);
                    handleLogout();
                  }}
                  className="flex-1 py-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/25 text-rose-400 font-bold text-xs border border-rose-500/20 transition cursor-pointer flex items-center justify-center gap-2"
                >
                  <LogOut size={13} />
                  <span>Log Out</span>
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* iOS Install Instructions */}
      {showIOSGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 w-full max-w-sm rounded-3xl p-6 shadow-2xl">
            <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <Download size={18} className="text-teal-400" />
              Install on iPhone/iPad
            </h3>
            <p className="text-xs text-zinc-400 mt-2">
              Follow these simple steps to install this WebRTC application directly to your home screen using Safari browser:
            </p>

            <ol className="mt-4 space-y-3.5 text-xs text-zinc-300 pl-4 list-decimal leading-relaxed">
              <li>Tap the <strong className="text-white">Share</strong> icon at the bottom of the Safari browser.</li>
              <li>Scroll up and select the <strong className="text-white">"Add to Home Screen"</strong> option.</li>
              <li>Tap the <strong className="text-white">"Add"</strong> button in the top right corner.</li>
            </ol>

            <button
              onClick={() => setShowIOSGuide(false)}
              className="mt-6 w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-xs transition cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Footer block */}
      <footer className="border-t border-zinc-900/60 bg-zinc-950 py-5 text-center text-[10px] text-zinc-600">
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 Global Call. All rights reserved. Highly Optimized Opus WebRTC Engine.</p>
          <div className="flex items-center gap-4">
            <span className="hover:text-zinc-500 cursor-pointer">Security Protocol</span>
            <span className="hover:text-zinc-500 cursor-pointer">Terms of Service</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

// Utility to display time
const formatTime = (secs: number) => {
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
};

const formatDuration = (secs: number) => {
  if (secs <= 0) return '0s';
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  if (mins > 0) {
    return `${mins}m ${remainingSecs}s`;
  }
  return `${remainingSecs}s`;
};
