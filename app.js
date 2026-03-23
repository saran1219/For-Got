// ================= FIREBASE IMPORTS =================
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDocs, deleteDoc, query } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-storage.js";

// ================= FIREBASE CONFIG =================
const firebaseConfig = {
    apiKey: 'AIzaSyDCZEJDPZE0eb-FSZYJ4opYHJtqRGQBQIs',
    authDomain: 'for-got-87f8d.firebaseapp.com',
    projectId: 'for-got-87f8d',
    storageBucket: 'for-got-87f8d.firebasestorage.app',
    messagingSenderId: '925376939820',
    appId: '1:925376939820:web:07a1e7fc0ee3b01ac04e89',
    measurementId: 'G-N5J9E8DZB7'
};

// ================= INIT =================
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const provider = new GoogleAuthProvider();

// ================= DOM HELPER =================
const $ = id => document.getElementById(id);

// ================= UI ELEMENTS =================
const loginContainer = $("loginContainer");
const appContent = $("appContent");
const googleLoginBtn = $("googleLoginBtn");
const logoutBtn = $("logoutBtn");
const userPhoto = $("userPhoto");
const userName = $("userName");

const taskName = $("taskName");
const taskDate = $("taskDate");
const taskTime = $("taskTime");
const taskImage = $("taskImage");
const taskMood = $("taskMood");
const repeatTask = $("repeatTask");
const setReminderBtn = $("setReminderBtn");
const alarmSound = $("alarmSound");

const recordBtn = $("recordBtn");
const recordStatus = $("recordStatus");

const reminderList = $("reminderList");
const remindersEmpty = $("remindersEmpty");

const reminderModal = $("reminderModal");
const modalTaskName = $("modalTaskName");
const modalImage = $("modalImage");
const modalPlayVoiceBtn = $("modalPlayVoiceBtn");
const modalSnoozeBtn = $("modalSnoozeBtn");
const modalDeclineBtn = $("modalDeclineBtn");
const notificationStatus = $("notificationStatus");

// ================= STATE =================
let currentUser = null;
let authReady = false; // Prevents race conditions
let reminders = [];
let lastNotificationAttemptAt = 0;

// Voice Recording
let mediaRecorder = null;
let audioChunks = [];
let currentVoiceBlob = null;
const testMoodBtn = document.getElementById("testMoodBtn");

// Alarm State
let activeAlarmId = null;
let alarmAudio = null;
let alarmLoopInterval = null;
let alarmAudioContext = null;
let alarmOscillator = null;

// ================= DB HELPERS (IndexedDB) =================
const DB_NAME = 'ForGotDB';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

async function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

async function saveBlobLocal(key, blob) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error("IDB Save Error", e); }
}

async function getBlobLocal(key) {
    try {
        const db = await openDB();
        return new Promise(resolve => {
            const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function deleteBlobLocal(key) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
    } catch (e) { }
}

// ================= NOTIFICATION UX =================
function setNotificationStatus(kind, message) {
    if (!notificationStatus) return;
    notificationStatus.classList.remove('hidden');
    notificationStatus.classList.remove('status-error', 'status-ok', 'status-warn');
    if (kind) notificationStatus.classList.add(`status-${kind}`);
    notificationStatus.textContent = message || '';
}

function clearNotificationStatus() {
    if (!notificationStatus) return;
    notificationStatus.classList.add('hidden');
    notificationStatus.textContent = '';
}

async function ensureNotificationPermission() {
    if (!('Notification' in window)) {
        setNotificationStatus('warn', 'Notifications are not supported in this browser.');
        return false;
    }

    try {
        if (Notification.permission === 'granted') {
            clearNotificationStatus();
            return true;
        }

        if (Notification.permission === 'denied') {
            setNotificationStatus(
                'error',
                'Notification permission is blocked. You can still add reminders, but alarms may only show while the app is open.'
            );
            return false;
        }

        if (Notification.permission === 'default') {
            const perm = await Notification.requestPermission();
            if (perm === 'granted') {
                clearNotificationStatus();
                return true;
            }
            setNotificationStatus(
                'warn',
                'Notifications were not enabled. You can still add reminders, but you may not receive system alerts.'
            );
            return false;
        }
    } catch {
        setNotificationStatus('error', 'Could not request notification permission.');
        return false;
    }

    return false;
}

async function notifyServiceWorker(reminder) {
    if (!('serviceWorker' in navigator)) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // Prevent flooding when multiple reminders fire at once.
    const now = Date.now();
    if (now - lastNotificationAttemptAt < 250) return;
    lastNotificationAttemptAt = now;

    try {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.active) {
            reg.active.postMessage({
                type: 'SHOW_NOTIFICATION',
                id: reminder.id,
                text: reminder.text || reminder.name,
                image: reminder.image,
                mood: reminder.mood
            });
        }
    } catch (e) {
        console.warn('SW postMessage failed', e);
    }
}

// ================= DATE/TIME HELPERS (LOCAL) =================
function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatLocalTime(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseLocalDateTime(dateStr, timeStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const [hh, mm] = String(timeStr).split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function addDaysToDateString(dateStr, days) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return formatLocalDate(dt);
}

// ================= CLOUD SYNC (OFFLINE QUEUE) =================
const PENDING_CLOUD_SAVE_KEY = 'for-got:pending-cloud-saves';
const PENDING_CLOUD_DELETE_KEY = 'for-got:pending-cloud-deletes';

function loadIdList(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function saveIdList(key, list) {
    try {
        localStorage.setItem(key, JSON.stringify(Array.from(new Set(list))));
    } catch { }
}

function queuePendingCloudSave(id) {
    const ids = loadIdList(PENDING_CLOUD_SAVE_KEY);
    if (!ids.includes(id)) ids.push(id);
    saveIdList(PENDING_CLOUD_SAVE_KEY, ids);
}

function queuePendingCloudDelete(id) {
    const ids = loadIdList(PENDING_CLOUD_DELETE_KEY);
    if (!ids.includes(id)) ids.push(id);
    saveIdList(PENDING_CLOUD_DELETE_KEY, ids);
}

function removePendingCloudSave(id) {
    saveIdList(PENDING_CLOUD_SAVE_KEY, loadIdList(PENDING_CLOUD_SAVE_KEY).filter(x => x !== id));
}

function removePendingCloudDelete(id) {
    saveIdList(PENDING_CLOUD_DELETE_KEY, loadIdList(PENDING_CLOUD_DELETE_KEY).filter(x => x !== id));
}

async function retryPendingCloudOps() {
    if (!currentUser || !db) return;
    if (!navigator.onLine) return;

    const pendingSaves = loadIdList(PENDING_CLOUD_SAVE_KEY);
    const pendingDeletes = loadIdList(PENDING_CLOUD_DELETE_KEY);

    for (const id of pendingSaves) {
        const r = reminders.find(x => x && x.id === id);
        if (!r) continue;
        try {
            await setDoc(doc(db, "users", currentUser.uid, "reminders", String(r.id)), r);
            removePendingCloudSave(id);
        } catch {
            // Keep queued.
        }
    }

    for (const id of pendingDeletes) {
        try {
            await deleteDoc(doc(db, "users", currentUser.uid, "reminders", String(id)));
            removePendingCloudDelete(id);
        } catch {
            // Keep queued.
        }
    }
}

// ================= AUTH FLOW =================
onAuthStateChanged(auth, async (user) => {
    authReady = true; // Auth is now determined
    if (user) {
        currentUser = user;
        updateUI(true);
        await loadReminders();
        await retryPendingCloudOps();
    } else {
        currentUser = null;
        updateUI(false);
        loadLocalReminders();
    }
});

function updateUI(isLoggedIn) {
    if (isLoggedIn) {
        userName.innerText = currentUser.displayName || "User";
        userPhoto.src = currentUser.photoURL || "";
        loginContainer.classList.add("hidden");
        appContent.classList.remove("hidden");
    } else {
        loginContainer.classList.remove("hidden");
        appContent.classList.add("hidden");
    }
}

googleLoginBtn.onclick = async () => {
    const originalText = googleLoginBtn.innerText;
    try {
        googleLoginBtn.disabled = true;
        googleLoginBtn.innerText = "Signing in...";
        await signInWithPopup(auth, provider);
        // UI toggling is handled by onAuthStateChanged().
    } catch (e) {
        console.error(e);
        alert("Login failed. Please try again.");
    } finally {
        googleLoginBtn.disabled = false;
        googleLoginBtn.innerText = originalText;
    }
};
logoutBtn.onclick = () => signOut(auth).catch(console.error);

// ================= DATA LOADING =================
async function loadReminders() {
    // Always start from local so offline-created reminders aren't lost.
    let local = [];
    try {
        const raw = localStorage.getItem('reminders');
        if (raw) local = JSON.parse(raw) || [];
    } catch { }

    try {
        if (currentUser) {
            const q = query(collection(db, "users", currentUser.uid, "reminders"));
            const snap = await getDocs(q);
            reminders = [];
            snap.forEach(d => reminders.push(d.data()));

            // Merge in local changes (local wins for matching IDs).
            for (const lr of local) {
                const idx = reminders.findIndex(r => r && r.id == lr.id);
                if (idx === -1) reminders.push(lr);
                else reminders[idx] = { ...reminders[idx], ...lr };
            }

            // If we deleted reminders while offline/logged out, filter them out so they don't "resurrect".
            const pendingDeletes = new Set(loadIdList(PENDING_CLOUD_DELETE_KEY).map(x => String(x)));
            reminders = reminders.filter(r => !pendingDeletes.has(String(r && r.id)));
        } else {
            reminders = local;
        }
    } catch (e) {
        console.error("Cloud Load Error", e);
        reminders = local;
    }

    renderReminders();
}

function loadLocalReminders() {
    try {
        const local = localStorage.getItem('reminders');
        if (local) reminders = JSON.parse(local);
    } catch (e) { }
    renderReminders();
}

function renderReminders() {
    reminderList.innerHTML = "";
    if (remindersEmpty) {
        if (!reminders || reminders.length === 0) remindersEmpty.classList.remove("hidden");
        else remindersEmpty.classList.add("hidden");
    }
    reminders.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    reminders.forEach(r => {
        const div = document.createElement("div");
        div.className = "reminder-item";

        // Formatting
        let displayDate = r.date;
        let displayTime = r.time;
        try {
            const d = new Date(`${r.date}T${r.time}`);
            displayDate = d.toLocaleDateString();
            displayTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { }

        const isSnoozed = r.snoozedUntil && r.snoozedUntil > Date.now();

        div.innerHTML = `
            <div class="reminder-info">
                <h3>${r.name}</h3>
                <p>
                    ${displayDate} at ${displayTime} 
                    ${r.repeatDaily ? '🔁' : ''} 
                    ${r.voiceData ? '🎤' : '🔔 '}
                    ${r.mood ? ' | Mood: ' + r.mood : ''}
                </p>
                ${isSnoozed ? '<small>💤 Snoozed</small>' : ''}
            </div>
            <button class="delete-btn" onclick="window.deleteReminder(${r.id})">Delete</button>
        `;
        reminderList.appendChild(div);
    });
}

// ================= ADD REMINDER =================
setReminderBtn.onclick = async () => {
    const name = (taskName.value || '').trim();
    const dateVal = taskDate.value;
    const timeVal = taskTime.value;

    if (!name || !dateVal || !timeVal) {
        alert("Please fill in Name, Date, and Time.");
        return;
    }

    const id = Date.now();
    let imageUrl = null;
    let voiceUrl = null;
    let attachmentsError = null;

    const originalBtnText = setReminderBtn.innerText;
    setReminderBtn.disabled = true;
    setReminderBtn.innerText = "Saving...";

    try {
        // Keep creation unblocked, but surface notification permission issues.
        await ensureNotificationPermission();

        // Image Handling
        const imgFile = taskImage.files[0];
        if (imgFile) {
            if (currentUser) {
                try {
                    const r = ref(storage, `users/${currentUser.uid}/reminders/${id}/image`);
                    await uploadBytes(r, imgFile);
                    imageUrl = await getDownloadURL(r);
                } catch (e) {
                    console.error(e);
                    attachmentsError = "Image upload failed. Reminder will be saved without the image.";
                }
            } else {
                const key = `local-image-${id}`;
                await saveBlobLocal(key, imgFile);
                imageUrl = `local:${key}`;
            }
        }

        // Voice Handling
        if (currentVoiceBlob) {
            if (currentUser) {
                try {
                    const r = ref(storage, `users/${currentUser.uid}/reminders/${id}/voice`);
                    await uploadBytes(r, currentVoiceBlob);
                    voiceUrl = await getDownloadURL(r);
                } catch (e) {
                    console.error(e);
                    attachmentsError = "Voice upload failed. Reminder will be saved without the voice note.";
                }
            } else {
                const key = `local-voice-${id}`;
                await saveBlobLocal(key, currentVoiceBlob);
                voiceUrl = `local:${key}`;
            }
        }

        const reminder = {
            id,
            name,
            date: dateVal,
            time: timeVal,
            repeatDaily: repeatTask.checked,
            mood: taskMood.value,
            image: imageUrl,
            voiceData: voiceUrl,
            alarmSound: alarmSound.value || null,
            lastTriggerId: null,
            snoozedUntil: null
        };

        reminders.push(reminder);
        await saveReminders(reminder);
        renderReminders();

        // Reset UI
        taskName.value = "";
        taskTime.value = "";
        repeatTask.checked = false;
        alarmSound.value = "";
        taskImage.value = "";
        currentVoiceBlob = null;
        recordStatus.innerText = "";
        recordBtn.innerText = "🎤 Record Voice";

        if (attachmentsError) setNotificationStatus('warn', attachmentsError);
    } finally {
        setReminderBtn.disabled = false;
        setReminderBtn.innerText = originalBtnText;
    }
};

// ================= SAVE / DELETE IMPL =================
async function saveReminders(specificReminder) {
    // Save to LocalStorage always as backup
    localStorage.setItem('reminders', JSON.stringify(reminders));

    // Save to Cloud if possible
    if (currentUser && db && specificReminder) {
        try {
            await setDoc(doc(db, "users", currentUser.uid, "reminders", String(specificReminder.id)), specificReminder);
            removePendingCloudSave(specificReminder.id);
        } catch (e) {
            console.error("Cloud Save Error", e);
            queuePendingCloudSave(specificReminder.id);
        }
    }
}

async function deleteReminder(id) {
    const reminder = reminders.find(r => r.id === id);
    reminders = reminders.filter(r => r.id !== id);
    renderReminders();
    localStorage.setItem('reminders', JSON.stringify(reminders));

    if (currentUser && db) {
        try {
            await deleteDoc(doc(db, "users", currentUser.uid, "reminders", String(id)));
            // Cleanup storage (optional, best effort)
            if (reminder) {
                if (reminder.image?.includes('firebase')) deleteObject(ref(storage, reminder.image)).catch(() => { });
                if (reminder.voiceData?.includes('firebase')) deleteObject(ref(storage, reminder.voiceData)).catch(() => { });
            }
        } catch (e) {
            console.error("Cloud Delete Error", e);
            queuePendingCloudDelete(id);
        }
    } else {
        // Logged out/offline: queue deletion so it can be applied after login/reconnect.
        queuePendingCloudDelete(id);
        removePendingCloudSave(id);
    }

    // Cleanup Local Blobs
    if (reminder) {
        if (reminder.image?.startsWith('local:')) deleteBlobLocal(reminder.image.replace('local:', ''));
        if (reminder.voiceData?.startsWith('local:')) deleteBlobLocal(reminder.voiceData.replace('local:', ''));
    }
}

window.deleteReminder = deleteReminder;

// ================= VOICE RECORDING (FIXED) =================
recordBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });

        // Track Check
        if (stream.getAudioTracks().length === 0) throw new Error("No audio track");

        let mimeType = 'audio/webm';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';

        mediaRecorder = new MediaRecorder(stream, { mimeType });
        audioChunks = [];

        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            currentVoiceBlob = new Blob(audioChunks, { type: mimeType });
            recordStatus.innerText = "Voice Recorded ✔";
            recordBtn.innerText = "🎤 Re-record";
        };

        mediaRecorder.start();
        recordStatus.innerText = "Recording...";
        recordBtn.innerText = "⏹ Stop";
    } catch (e) {
        console.error(e);
        alert("Mic Error: " + e.message);
    }
};

// ================= ALARM SYSTEM =================
// 1. Check Loop
setInterval(() => {
    if (!authReady && !currentUser) {
        // Fallback: if auth isn't ready but we have local reminders, check them.
    }
    checkAlarmTrigger();
}, 1000);

// Make sure we catch missed triggers when the tab returns to the foreground.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkAlarmTrigger();
});

window.addEventListener('focus', () => {
    checkAlarmTrigger();
});

async function checkAlarmTrigger() {
    const now = new Date();
    const dateStr = formatLocalDate(now); // Matches <input type="date"> value.
    const timeStr = formatLocalTime(now);

    for (const r of reminders) {
        let shouldTrigger = false;

        // Snooze Check
        if (r.snoozedUntil) {
            if (now.getTime() >= r.snoozedUntil) {
                shouldTrigger = true;
                r.snoozedUntil = null; // Clear snooze
                r.lastTriggerId = `${dateStr}-${timeStr}`;
            }
        } else if (r.date === dateStr && r.time === timeStr) {
            const triggerId = `${dateStr}-${timeStr}`;
            if (r.lastTriggerId !== triggerId) {
                shouldTrigger = true;
                r.lastTriggerId = triggerId;
            }
        }

        if (shouldTrigger) {
            fireAlarm(r);
            saveReminders(r); // Persist snooze / lastTrigger updates.
        }
    }
}

// 2. Fire Alarm
function fireAlarm(reminder, { notify = true } = {}) {
    if (activeAlarmId === reminder.id) return; // Already ringing
    activeAlarmId = reminder.id;

    showAlarmModal(reminder);

    // Call Mood Effects (New Video/GIF)
    playMoodVideo(reminder);

    playAlarmSequence(reminder);

    // C. Notification (system)
    if (notify) notifyServiceWorker(reminder);
}

// Show Alarm Modal
function showAlarmModal(reminder) {
    modalTaskName.innerText = reminder.name;
    reminderModal.classList.remove("hidden");

    // Ensure base state
    const modalContent = reminderModal.querySelector('.modal-content');

    modalImage.style.display = "none";
    if (reminder.image) {
        resolveUrl(reminder.image).then(url => {
            modalImage.src = url;
            modalImage.style.display = "block";
        });
    }
}

function playMoodVideo(reminder) {
    const container = document.getElementById("moodMediaContainer");
    if (!container) return;

    // 1. CLEAR & RESET
    // clear innerHTML to remove old video/state completely
    container.innerHTML = "";
    container.style.display = "none";

    console.log("[Mood] Requested for:", reminder);

    if (!reminder || !reminder.mood) {
        console.log("[Mood] No mood set for this reminder.");
        return;
    }

    const moodVideos = {
        funny: "media/funny.mp4",
        cute: "media/cute.mp4",
        motivational: "media/motivation.mp4",
        strict: "media/strict.mp4"
    };

    const src = moodVideos[reminder.mood];
    if (!src) {
        console.warn("[Mood] No video source found for mood:", reminder.mood);
        return;
    }

    console.log("[Mood] Creating new video element for:", src);

    // 2. CREATE NEW VIDEO ELEMENT
    const video = document.createElement("video");
    video.id = "moodVideo";
    video.src = src;
    video.style.width = "100%";
    video.style.maxHeight = "220px";
    video.style.borderRadius = "10px";

    // MANDATORY ATTRIBUTES
    video.muted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;

    // Append to DOM
    container.appendChild(video);
    container.style.display = "block";

    // 3. HANDLE AUTOPLAY PROMISE
    const playPromise = video.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.warn("[Mood] Autoplay prevented:", error);
            // We just let it fail silently as requested, 
            // but the muted attribute usually allows it.
        });
    }

    // 4. INTERACTION UNLOCK
    const unlockAudio = () => {
        if (video && !video.paused) {
            video.muted = false;
            console.log("[Mood] Unmuted by interaction.");
        }
        // If it was paused (autoplay failed), try playing again
        if (video && video.paused) {
            video.play().catch(() => { });
            video.muted = false;
        }

        // Remove listeners
        ["click", "touchstart"].forEach(evt =>
            reminderModal.removeEventListener(evt, unlockAudio)
        );
    };

    // Add One-Time Listeners to the Modal
    ["click", "touchstart"].forEach(evt =>
        reminderModal.addEventListener(evt, unlockAudio, { once: true })
    );
}

// Test Mood Button Logic
if (testMoodBtn) {
    testMoodBtn.onclick = (e) => {
        e.preventDefault(); // Prevent form submission
        const mood = taskMood.value;
        if (!mood) {
            alert("Please select a mood first via the dropdown!");
            return;
        }

        // Mock Reminder object for preview
        const mockReminder = {
            name: "Mood Preview",
            mood: mood,
            image: null
        };

        // Open Modal to test
        showAlarmModal(mockReminder);
        playMoodVideo(mockReminder);
    };
}

// Helper: Safe Audio Loader
function loadAlarmAudio(src) {
    return new Promise((resolve, reject) => {
        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = src;

        const cleanup = () => {
            audio.oncanplaythrough = null;
            audio.onerror = null;
        };

        audio.oncanplaythrough = () => {
            if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
                cleanup();
                reject(new Error(`Invalid duration: ${audio.duration}`));
                return;
            }
            cleanup();
            resolve(audio);
        };

        audio.onerror = (e) => {
            cleanup();
            reject(new Error(`Failed to load ${src}: ${e.message || 'Unknown error'}`));
        };

        audio.load();
    });
}

// 3. Play Alarm Sequence
async function playAlarmSequence(reminder) {
    stopAlarmAudio(); // Stop any existing

    // STRICT PRIORITY CHECK

    // 1. User Voice
    if (reminder.voiceData) {
        try {
            const url = await resolveUrl(reminder.voiceData);
            if (url) {
                alarmAudio = new Audio(url);
                alarmAudio.loop = true;
                await alarmAudio.play();
                console.log(`[Alarm] Playing user voice.`);
                return; // STOP. No mood sound, no default sound.
            }
        } catch (e) {
            console.error("Voice playback error", e);
        }
    }

    // 2. Default Alarm (Only if NO voice)
    tryLoadDefaultAlarm(reminder);
}

async function tryLoadDefaultAlarm(reminder) {
    // Try to load: Selected Sound OR Default "sounds/alarm.mp3"
    let soundToPlay = 'sounds/alarm.mp3'; // Default

    if (reminder.alarmSound && reminder.alarmSound !== "") {
        soundToPlay = reminder.alarmSound;
    }

    // Attempt load
    try {
        const audio = await loadAlarmAudio(soundToPlay);
        alarmAudio = audio;
        alarmAudio.loop = true;
        alarmAudio.volume = 0.2;
        await alarmAudio.play();
        console.log(`[Alarm] Playing default/selected sound: ${soundToPlay}`);

        // Fade In
        if (alarmLoopInterval) clearInterval(alarmLoopInterval);
        let vol = 0.2;
        alarmLoopInterval = setInterval(() => {
            if (!activeAlarmId || !alarmAudio || alarmAudio.paused) {
                clearInterval(alarmLoopInterval);
                return;
            }
            vol = Math.min(1.0, vol + 0.05);
            alarmAudio.volume = vol;
            if (vol >= 1.0) clearInterval(alarmLoopInterval);
        }, 300);

    } catch (e) {
        console.error("Default alarm failed", e);
        playOscillatorFallback();
    }
}

function playOscillatorFallback() {
    try {
        if (!alarmAudioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            alarmAudioContext = new AudioContext();
        }

        // Resume if suspended
        if (alarmAudioContext.state === 'suspended') {
            alarmAudioContext.resume();
        }

        const oscillator = alarmAudioContext.createOscillator();
        const gainNode = alarmAudioContext.createGain();

        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(440, alarmAudioContext.currentTime);
        oscillator.frequency.setValueAtTime(880, alarmAudioContext.currentTime + 0.2);

        // Pulse Volume
        gainNode.gain.setValueAtTime(0.1, alarmAudioContext.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(alarmAudioContext.destination);

        oscillator.start();
        alarmOscillator = oscillator;

        // Simple Beep Loop
        if (alarmLoopInterval) clearInterval(alarmLoopInterval);
        let toggle = false;
        alarmLoopInterval = setInterval(() => {
            if (alarmOscillator) {
                const now = alarmAudioContext.currentTime;
                alarmOscillator.frequency.setValueAtTime(toggle ? 880 : 440, now);
                toggle = !toggle;
            }
        }, 500);

        console.log("[Alarm] Playing oscillator fallback.");

    } catch (e) {
        console.error("Oscillator Fallback Failed:", e);
    }
}

function stopAlarmAudio() {
    // Stop Audio Element
    if (alarmAudio) {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
        alarmAudio = null;
    }
    // Stop Interval
    if (alarmLoopInterval) {
        clearInterval(alarmLoopInterval);
        alarmLoopInterval = null;
    }
    // Stop Oscillator
    if (alarmOscillator) {
        try {
            alarmOscillator.stop();
            alarmOscillator.disconnect();
        } catch (e) { }
        alarmOscillator = null;
    }
    // Close Context
    if (alarmAudioContext) {
        alarmAudioContext.close().catch(() => { });
        alarmAudioContext = null;
    }

    // Stop Vibration
    if (navigator.vibrate) navigator.vibrate(0);

    // Clear Mood Media
    const v = document.getElementById("moodVideo");
    if (v) {
        v.pause();
        v.src = "";
    }
    const container = document.getElementById("moodMediaContainer");
    if (container) container.style.display = "none";
}

// Helper to resolve local: vs http URLs
async function resolveUrl(path) {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    if (path.startsWith('local:')) {
        const key = path.replace('local:', '');
        const blob = await getBlobLocal(key);
        if (blob) return URL.createObjectURL(blob);
    }
    return null;
}

// ================= ACTIONS (Snooze/Dismiss) =================

// Triggered by Modal Buttons
modalSnoozeBtn.onclick = () => {
    if (activeAlarmId) handleAction(activeAlarmId, 'snooze');
};
modalDeclineBtn.onclick = () => {
    if (activeAlarmId) handleAction(activeAlarmId, 'dismiss');
};

// Triggered by Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'NOTIFICATION_ACTION') {
            console.log("Received Action:", event.data);
            handleAction(event.data.id, event.data.action);
        }
    });
}

function handleAction(id, action) {
    if (!id) return;
    const r = reminders.find(rem => rem.id == id);
    if (!r) return;

    if (action === 'snooze') {
        snoozeReminder(r);
    } else if (action === 'dismiss') {
        dismissReminder(r);
    } else if (action === 'open') {
        fireAlarm(r, { notify: false });
    }
}

function snoozeReminder(r) {
    stopAlarmAudio();
    reminderModal.classList.add("hidden");
    activeAlarmId = null;

    r.snoozedUntil = Date.now() + (5 * 60 * 1000); // 5 mins
    saveReminders(r);
    renderReminders();
}

function dismissReminder(r) {
    stopAlarmAudio();
    reminderModal.classList.add("hidden");
    activeAlarmId = null;

    if (r.repeatDaily) {
        r.date = addDaysToDateString(r.date, 1);
        r.lastTriggerId = null;
        r.snoozedUntil = null;
        saveReminders(r);
    } else {
        deleteReminder(r.id);
    }
    renderReminders();
}

function triggerModal(r) {
    if (reminderModal.classList.contains("hidden")) {
        showAlarmModal(r);
        playMoodVideo(r);
    }
}

modalPlayVoiceBtn.onclick = async () => {
    if (activeAlarmId) return;
};

// ================= INIT CALLS =================
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => {
        console.error('Service worker registration failed:', e);
    });
}

window.addEventListener('online', () => retryPendingCloudOps());

// Initial state: keep app hidden until Firebase auth resolves.
loginContainer.classList.remove("hidden");
appContent.classList.add("hidden");
