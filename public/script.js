const socket = io();

// ============================================================
//  КОМНАТА И РОЛЬ
// ============================================================
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room');
let isHost = false;
let nickname = '';

if (!roomId) {
    roomId = Math.random().toString(36).substring(2, 8);
    const newUrl = window.location.pathname + `?room=${roomId}`;
    window.history.replaceState({}, '', newUrl);
}

// ============================================================
//  СОСТОЯНИЕ
// ============================================================
let player = null;
let playerType = null;
let suppressEvents = false;
let autoHideTimer = null;
let seekUpdateInterval = null;
let isSeeking = false;
let currentVolume = 1;
let previousVolume = 1;

// ============================================================
//  DOM
// ============================================================
const playerContainer = document.getElementById('playerContainer');
const emptyState = document.getElementById('emptyState');
const emptyUrlInput = document.getElementById('emptyUrlInput');
const emptyLoadBtn = document.getElementById('emptyLoadBtn');
const topBar = document.getElementById('topBar');
const roleLabel = document.getElementById('roleLabel');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const usersBtn = document.getElementById('usersBtn');
const usersCount = document.getElementById('usersCount');
const controlsOverlay = document.getElementById('controlsOverlay');
const playPauseBtn = document.getElementById('playPauseBtn');
const rewindBtn = document.getElementById('rewindBtn');
const forwardBtn = document.getElementById('forwardBtn');
const volumeBtn = document.getElementById('volumeBtn');
const volumeSlider = document.getElementById('volumeSlider');
const loadNewBtn = document.getElementById('loadNewBtn');
const seekBar = document.getElementById('seekBar');
const timeCurrentMini = document.getElementById('timeCurrentMini');
const timeTotalMini = document.getElementById('timeTotalMini');
const chatToggle = document.getElementById('chatToggle');
const historyToggle = document.getElementById('historyToggle');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const chatPanel = document.getElementById('chatPanel');
const historyPanel = document.getElementById('historyPanel');
const usersPanel = document.getElementById('usersPanel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const historyList = document.getElementById('historyList');
const usersList = document.getElementById('usersList');
const loadModal = document.getElementById('loadModal');
const modalUrlInput = document.getElementById('modalUrlInput');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalLoadBtn = document.getElementById('modalLoadBtn');
const nickModal = document.getElementById('nickModal');
const nickInput = document.getElementById('nickInput');
const nickBtn = document.getElementById('nickBtn');
const toast = document.getElementById('toast');

// ============================================================
//  YOUTUBE API
// ============================================================
let ytReady = false;
let ytQueued = null;

function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) { ytReady = true; return; }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube-nocookie.com/iframe_api';
    tag.onerror = () => {
        const tag2 = document.createElement('script');
        tag2.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag2);
    };
    document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function() {
    ytReady = true;
    if (ytQueued) {
        const q = ytQueued;
        ytQueued = null;
        createYouTubePlayer(q.videoId);
    }
};

// ============================================================
//  ПАРСИНГ ССЫЛОК
// ============================================================
function parseUrl(url) {
    url = url.trim();
    if (!url) return null;
    const ytRegex = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const m = url.match(ytRegex);
    if (m) return { type: 'youtube', id: m[1], url };
    return { type: 'video', url };
}

// ============================================================
//  ПЛЕЕР
// ============================================================
function destroyPlayer() {
    if (seekUpdateInterval) { clearInterval(seekUpdateInterval); seekUpdateInterval = null; }
    if (player && playerType === 'youtube' && player.destroy) {
        try { player.destroy(); } catch (e) {}
    }
    playerContainer.innerHTML = '';
    player = null;
    playerType = null;
}

function createYouTubePlayer(videoId) {
    destroyPlayer();
    emptyState.classList.add('hidden');

    const div = document.createElement('div');
    div.id = 'yt-player';
    div.style.width = '100%';
    div.style.height = '100%';
    playerContainer.appendChild(div);
    playerType = 'youtube';

    player = new YT.Player('yt-player', {
        videoId: videoId,
        playerVars: {
            autoplay: 1, controls: 0, modestbranding: 1,
            rel: 0, fs: 0, playsinline: 1, disablekb: 1
        },
        events: {
            onReady: () => {
                setVolume(currentVolume);
                startSeekUpdater();
                showControls();
            },
            onStateChange: (e) => {
                updatePlayButton();
                if (suppressEvents) return;
                const time = player.getCurrentTime();
                if (e.data === YT.PlayerState.PLAYING) {
                    socket.emit('sync', { action: 'play', time });
                } else if (e.data === YT.PlayerState.PAUSED) {
                    socket.emit('sync', { action: 'pause', time });
                }
            }
        }
    });
}

function createVideoPlayer(url) {
    destroyPlayer();
    emptyState.classList.add('hidden');

    const video = document.createElement('video');
    video.src = url;
    video.controls = false;
    video.autoplay = true;
    video.playsInline = true;
    video.volume = currentVolume;

    video.addEventListener('play', () => {
        updatePlayButton();
        if (suppressEvents) return;
        socket.emit('sync', { action: 'play', time: video.currentTime });
    });
    video.addEventListener('pause', () => {
        updatePlayButton();
        if (suppressEvents) return;
        socket.emit('sync', { action: 'pause', time: video.currentTime });
    });
    video.addEventListener('seeked', () => {
        if (suppressEvents) return;
        socket.emit('sync', { action: 'seek', time: video.currentTime });
    });
    video.addEventListener('loadedmetadata', () => { updatePlayButton(); updateTotalTime(); });

    playerContainer.appendChild(video);
    player = video;
    playerType = 'video';
    startSeekUpdater();
    showControls();
}

async function loadVideo(url, { broadcast = true, title = '' } = {}) {
    const parsed = parseUrl(url);
    if (!parsed) { showToast('Неверная ссылка'); return; }

    let videoTitle = title;
    if (!videoTitle && parsed.type === 'youtube') {
        try {
            const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
            const data = await r.json();
            videoTitle = data.title || url;
        } catch (e) { videoTitle = url; }
    }
    if (!videoTitle) videoTitle = url;

    if (parsed.type === 'youtube') {
        if (ytReady) createYouTubePlayer(parsed.id);
        else ytQueued = { videoId: parsed.id };
    } else {
        createVideoPlayer(parsed.url);
    }

    if (broadcast) {
        socket.emit('load video', { url: parsed.url, type: parsed.type, title: videoTitle });
    }
}

// ============================================================
//  УПРАВЛЕНИЕ ПЛЕЕРОМ
// ============================================================
function togglePlay() {
    if (!player) return;
    if (playerType === 'youtube') {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) player.pauseVideo();
        else player.playVideo();
    } else {
        if (player.paused) player.play();
        else player.pause();
    }
    showControls();
}

function seekRelative(seconds) {
    if (!player) return;
    const cur = getCurrentTime();
    const dur = getDuration();
    let newTime = cur + seconds;
    if (newTime < 0) newTime = 0;
    if (newTime > dur) newTime = dur;

    if (playerType === 'youtube') {
        player.seekTo(newTime, true);
        socket.emit('sync', { action: 'seek', time: newTime });
    } else {
        player.currentTime = newTime;
    }
    showControls();
}

function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    currentVolume = v;
    if (player) {
        if (playerType === 'youtube') {
            if (v === 0) player.mute();
            else { player.unMute(); player.setVolume(v * 100); }
        } else {
            player.volume = v;
        }
    }
    volumeSlider.value = v;
    updateVolumeIcon();
}

function updateVolumeIcon() {
    if (currentVolume === 0) volumeBtn.textContent = '🔇';
    else if (currentVolume < 0.5) volumeBtn.textContent = '🔉';
    else volumeBtn.textContent = '🔊';
}

function updatePlayButton() {
    if (!player) { playPauseBtn.textContent = '▶'; return; }
    let playing = false;
    if (playerType === 'youtube') {
        playing = player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING;
    } else {
        playing = !player.paused;
    }
    playPauseBtn.textContent = playing ? '❚❚' : '▶';
}

function getCurrentTime() {
    if (!player) return 0;
    if (playerType === 'youtube') return player.getCurrentTime ? player.getCurrentTime() : 0;
    return player.currentTime || 0;
}

function getDuration() {
    if (!player) return 0;
    if (playerType === 'youtube') return player.getDuration ? player.getDuration() : 0;
    return player.duration || 0;
}

function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function updateTotalTime() {
    timeTotalMini.textContent = formatTime(getDuration());
}

function startSeekUpdater() {
    if (seekUpdateInterval) clearInterval(seekUpdateInterval);
    seekUpdateInterval = setInterval(() => {
        if (isSeeking || !player) return;
        const cur = getCurrentTime();
        const dur = getDuration();
        if (dur > 0) {
            seekBar.value = (cur / dur) * 100;
            timeCurrentMini.textContent = formatTime(cur);
            timeTotalMini.textContent = formatTime(dur);
        }
    }, 500);
}

// ============================================================
//  ОБРАБОТЧИКИ UI
// ============================================================
playPauseBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
rewindBtn.addEventListener('click', (e) => { e.stopPropagation(); seekRelative(-10); });
forwardBtn.addEventListener('click', (e) => { e.stopPropagation(); seekRelative(10); });

volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentVolume === 0) {
        setVolume(previousVolume || 1);
    } else {
        previousVolume = currentVolume;
        setVolume(0);
    }
});

volumeSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    setVolume(parseFloat(e.target.value));
});

seekBar.addEventListener('mousedown', () => { isSeeking = true; });
seekBar.addEventListener('touchstart', () => { isSeeking = true; });
seekBar.addEventListener('mouseup', () => { isSeeking = false; });
seekBar.addEventListener('touchend', () => { isSeeking = false; });
seekBar.addEventListener('input', (e) => {
    if (!player) return;
    const dur = getDuration();
    const newTime = (e.target.value / 100) * dur;
    timeCurrentMini.textContent = formatTime(newTime);
});
seekBar.addEventListener('change', (e) => {
    if (!player) return;
    const dur = getDuration();
    const newTime = (e.target.value / 100) * dur;
    if (playerType === 'youtube') {
        player.seekTo(newTime, true);
        socket.emit('sync', { action: 'seek', time: newTime });
    } else {
        player.currentTime = newTime;
    }
    isSeeking = false;
    showControls();
});

loadNewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    loadModal.classList.remove('hidden');
    setTimeout(() => modalUrlInput.focus(), 100);
});

modalCancelBtn.addEventListener('click', () => {
    loadModal.classList.add('hidden');
    modalUrlInput.value = '';
});

modalLoadBtn.addEventListener('click', () => {
    const url = modalUrlInput.value.trim();
    if (!url) return;
    loadVideo(url);
    loadModal.classList.add('hidden');
    modalUrlInput.value = '';
});

modalUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalLoadBtn.click();
});

emptyLoadBtn.addEventListener('click', () => {
    const url = emptyUrlInput.value.trim();
    if (!url) return;
    loadVideo(url);
    emptyUrlInput.value = '';
});

emptyUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') emptyLoadBtn.click();
});

fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const el = document.documentElement;
    if (!document.fullscreenElement) {
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
});

// ============================================================
//  СИНХРОНИЗАЦИЯ
// ============================================================
socket.on('load video', async (data) => {
    await loadVideo(data.url, { broadcast: false, title: data.title });
    addSystemMessage(`▶ ${data.title}`);
    showToast(`▶ ${data.title}`);
});

socket.on('sync', ({ action, time }) => {
    if (!player) return;
    suppressEvents = true;

    try {
        if (playerType === 'youtube') {
            if (action === 'play') { player.seekTo(time, true); player.playVideo(); }
            else if (action === 'pause') { player.seekTo(time, true); player.pauseVideo(); }
            else if (action === 'seek') { player.seekTo(time, true); }
        } else {
            if (action === 'play') { player.currentTime = time; player.play(); }
            else if (action === 'pause') { player.currentTime = time; player.pause(); }
            else if (action === 'seek') { player.currentTime = time; }
        }
    } catch (e) { console.error('Sync error:', e); }

    setTimeout(() => {
        suppressEvents = false;
        updatePlayButton();
    }, 500);
});

socket.on('room state', ({ currentVideo, history, isHost: h, users }) => {
    isHost = h;
    roleLabel.textContent = isHost ? 'Хост' : 'Гость';

    if (!isHost) {
        copyLinkBtn.style.display = 'none';
    }

    if (currentVideo) {
        loadVideo(currentVideo.url, { broadcast: false, title: currentVideo.title });
        addSystemMessage(`▶ Сейчас: ${currentVideo.title}`);
    }
    renderHistory(history);
    if (users) renderUsers(users);
});

socket.on('history update', (items) => renderHistory(items));

socket.on('user joined', ({ nickname: n }) => {
    addSystemMessage(`${n} присоединился`);
});

socket.on('users update', (users) => renderUsers(users));

socket.on('host changed', ({ nickname: n }) => {
    addSystemMessage(`${n} теперь хост`);
});

// ============================================================
//  УЧАСТНИКИ
// ============================================================
function renderUsers(users) {
    usersCount.textContent = users.length;
    usersList.innerHTML = '';

    const sorted = [...users].sort((a, b) => (b.isHost ? 1 : 0) - (a.isHost ? 1 : 0));

    sorted.forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-item';
        const initial = (u.nickname || '?').charAt(0).toUpperCase();
        div.innerHTML = `
            <div class="user-avatar">${escapeHtml(initial)}</div>
            <div class="user-info">
                <div class="user-name">${escapeHtml(u.nickname)}</div>
                <div class="user-role">${u.isHost ? 'Владелец комнаты' : 'Зритель'}</div>
            </div>
            ${u.isHost ? '<div class="user-host-badge">Хост</div>' : ''}
        `;
        usersList.appendChild(div);
    });
}

// ============================================================
//  ЧАТ
// ============================================================
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addMessage({ message, sender, own }) {
    const div = document.createElement('div');
    div.className = 'chat-message' + (own ? ' own' : '');
    div.innerHTML = `<span class="sender">${escapeHtml(sender)}</span>${escapeHtml(message)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-message system';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatSend.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    socket.emit('chat', { message: msg });
    addMessage({ message: msg, sender: nickname, own: true });
    chatInput.value = '';
});

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') chatSend.click();
});

socket.on('chat', ({ message, sender }) => addMessage({ message, sender, own: false }));
socket.on('system', (text) => addSystemMessage(text));

// ============================================================
//  ИСТОРИЯ
// ============================================================
function renderHistory(items) {
    historyList.innerHTML = '';
    if (!items || items.length === 0) {
        historyList.innerHTML = '<div class="chat-message system">Пока пусто</div>';
        return;
    }
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const date = new Date(item.timestamp).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        div.innerHTML = `
            <div class="title">${escapeHtml(item.title)}</div>
            <div class="meta">${item.type === 'youtube' ? '▶ YouTube' : '🎬 Видео'} • ${date}</div>
        `;
        div.addEventListener('click', () => {
            loadVideo(item.url, { title: item.title });
            closeAllPanels();
        });
        historyList.appendChild(div);
    });
}

// ============================================================
//  ПАНЕЛИ
// ============================================================
function closeAllPanels() {
    chatPanel.classList.remove('visible');
    historyPanel.classList.remove('visible');
    usersPanel.classList.remove('visible');
    chatToggle.classList.remove('active');
    historyToggle.classList.remove('active');
    usersBtn.classList.remove('active');
}

chatToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = chatPanel.classList.contains('visible');
    closeAllPanels();
    if (!wasOpen) {
        chatPanel.classList.add('visible');
        chatToggle.classList.add('active');
        setTimeout(() => chatInput.focus(), 300);
    }
});

historyToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = historyPanel.classList.contains('visible');
    closeAllPanels();
    if (!wasOpen) {
        historyPanel.classList.add('visible');
        historyToggle.classList.add('active');
    }
});

usersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = usersPanel.classList.contains('visible');
    closeAllPanels();
    if (!wasOpen) {
        usersPanel.classList.add('visible');
        usersBtn.classList.add('active');
    }
});

document.getElementById('chatClose').addEventListener('click', closeAllPanels);
document.getElementById('historyClose').addEventListener('click', closeAllPanels);
document.getElementById('usersClose').addEventListener('click', closeAllPanels);

// ============================================================
//  ОВЕРЛЕЙ — показ/скрытие
// ============================================================
function showControls() {
    controlsOverlay.classList.add('visible');
    topBar.classList.add('visible');
    resetAutoHide();
}

function hideControls() {
    if (chatPanel.classList.contains('visible')) return;
    if (historyPanel.classList.contains('visible')) return;
    if (usersPanel.classList.contains('visible')) return;
    if (!loadModal.classList.contains('hidden')) return;
    if (!nickModal.classList.contains('hidden')) return;

    controlsOverlay.classList.remove('visible');
    topBar.classList.remove('visible');
    clearTimeout(autoHideTimer);
}

function resetAutoHide() {
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(hideControls, 3000);
}

// ═══════════════════════════════════════════════════════════════
//  ПОКАЗ ОВЕРЛЕЯ ПО ДВИЖЕНИЮ МЫШИ / ТАПУ (как в YouTube)
// ═══════════════════════════════════════════════════════════════

let lastMoveTime = 0;
document.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMoveTime < 80) return;
    lastMoveTime = now;

    if (!controlsOverlay.classList.contains('visible')) {
        showControls();
    } else {
        resetAutoHide();
    }
});

document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.controls-overlay')) return;
    if (e.target.closest('.top-bar')) return;
    if (e.target.closest('.side-panel')) return;
    if (e.target.closest('.modal')) return;

    if (!controlsOverlay.classList.contains('visible')) {
        showControls();
    } else {
        resetAutoHide();
    }
}, { passive: true });

controlsOverlay.addEventListener('mousemove', resetAutoHide);
topBar.addEventListener('mousemove', resetAutoHide);

// Двойной клик по видео — фуллскрин
document.getElementById('videoStage').addEventListener('dblclick', (e) => {
    if (e.target.closest('.controls-overlay')) return;
    if (e.target.closest('.top-bar')) return;
    fullscreenBtn.click();
});

// ============================================================
//  TOAST
// ============================================================
let toastTimer;
function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ============================================================
//  КОПИРОВАТЬ ССЫЛКУ
// ============================================================
copyLinkBtn.addEventListener('click', () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showToast('🔗 Ссылка скопирована!');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('🔗 Ссылка скопирована!');
    });
});

// ============================================================
//  СТАРТ СЕССИИ
// ============================================================
function startSession(nick) {
    nickname = nick;
    sessionStorage.setItem('wp_nickname', nick);
    socket.emit('join room', { roomId, nickname: nick });
    nickModal.classList.add('hidden');
    addSystemMessage(`Ты в комнате ${roomId}`);
    showControls();
    setTimeout(hideControls, 4000);
}

nickBtn.addEventListener('click', () => {
    const nick = nickInput.value.trim() || 'Гость';
    startSession(nick);
});

nickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nickBtn.click();
});

// ============================================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================================
loadYouTubeAPI();
setVolume(1);

const savedNick = sessionStorage.getItem('wp_nickname');
if (savedNick) {
    nickModal.classList.add('hidden');
    startSession(savedNick);
} else {
    setTimeout(() => nickInput.focus(), 200);
}

// ============================================================
//  ГОРЯЧИЕ КЛАВИШИ
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekRelative(-10); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekRelative(10); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setVolume(currentVolume + 0.05); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setVolume(currentVolume - 0.05); }
    else if (e.key === 'f' || e.key === 'F') { fullscreenBtn.click(); }
    else if (e.key === 'm' || e.key === 'M') { volumeBtn.click(); }
    else if (e.key === 'c' || e.key === 'C') { chatToggle.click(); }
});