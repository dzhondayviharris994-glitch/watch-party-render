const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const HISTORY_FILE = path.join(__dirname, 'history.json');
let roomsData = {};

try {
    if (fs.existsSync(HISTORY_FILE)) {
        roomsData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
} catch (e) { roomsData = {}; }

function saveData() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(roomsData, null, 2), 'utf-8');
    } catch (e) { console.error('Save error:', e); }
}

function getRoom(roomId) {
    if (!roomsData[roomId]) {
        roomsData[roomId] = {
            currentVideo: null,
            history: [],
            hostId: null,
            users: {}
        };
    }
    if (!roomsData[roomId].users) roomsData[roomId].users = {};
    return roomsData[roomId];
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('join room', ({ roomId, nickname }) => {
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.nickname = nickname || 'Гость';

        const room = getRoom(roomId);

        // Первый вошедший становится хостом
        let isHost = false;
        if (!room.hostId) {
            room.hostId = socket.id;
            isHost = true;
        } else if (room.hostId === socket.id) {
            isHost = true;
        }

        // Сохраняем пользователя
        room.users[socket.id] = {
            nickname: socket.data.nickname,
            isHost: isHost,
            joinedAt: Date.now()
        };

        saveData();

        // Отправляем текущее состояние
        socket.emit('room state', {
            currentVideo: room.currentVideo,
            history: room.history,
            isHost: isHost,
            users: Object.values(room.users)
        });

        // Остальным — что зашёл новый
        socket.to(roomId).emit('user joined', {
            id: socket.id,
            nickname: socket.data.nickname,
            isHost: isHost
        });

        // Всем — обновлённый список
        io.to(roomId).emit('users update', Object.values(room.users));

        console.log(`${socket.data.nickname} → ${roomId} ${isHost ? '(HOST)' : '(guest)'}`);
    });

    socket.on('sync', ({ action, time }) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        socket.to(roomId).emit('sync', { action, time, from: socket.data.nickname });
    });

    socket.on('load video', ({ url, type, title }) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;

        const room = getRoom(roomId);
        const videoData = {
            url,
            type,
            title: title || url,
            addedBy: socket.data.nickname,
            timestamp: Date.now()
        };

        room.currentVideo = videoData;

        if (room.history.length === 0 || room.history[0].url !== url) {
            room.history.unshift(videoData);
            room.history = room.history.slice(0, 50);
        }

        saveData();
        io.to(roomId).emit('load video', videoData);
        io.to(roomId).emit('history update', room.history);
    });

    socket.on('chat', ({ message }) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        io.to(roomId).emit('chat', {
            message,
            sender: socket.data.nickname,
            senderId: socket.id,
            timestamp: Date.now()
        });
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (roomId) {
            const room = getRoom(roomId);
            delete room.users[socket.id];

            // Если хост вышел — передаём права первому оставшемуся
            if (room.hostId === socket.id) {
                const remaining = Object.keys(room.users);
                if (remaining.length > 0) {
                    room.hostId = remaining[0];
                    room.users[remaining[0]].isHost = true;
                    io.to(roomId).emit('host changed', {
                        newHostId: remaining[0],
                        nickname: room.users[remaining[0]].nickname
                    });
                } else {
                    room.hostId = null;
                }
            }

            saveData();
            io.to(roomId).emit('users update', Object.values(room.users));
            socket.to(roomId).emit('system', `${socket.data.nickname} отключился`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Watch Party запущен`);
    console.log(`   Локально: http://localhost:${PORT}`);
    console.log(`   По сети:  http://<твой-IP>:${PORT}\n`);
});