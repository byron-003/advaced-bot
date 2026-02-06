require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const db = require("./db"); 

const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)));

const SECRET = process.env.JWT_SECRET || "SUPER_SECRET_KEY";
const PORT = process.env.PORT || 5000;
const INACTIVITY_LIMIT = 5 * 60 * 1000; 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static("public"));

/* ---------- GLOBALS ---------- */
const onlineUsers = new Map(); 
const userSocketMap = new Map(); 

function getUniqueOnlineUsers() {
  const uniqueMap = new Map();
  for (const [socketId, user] of onlineUsers) {
    if (!uniqueMap.has(user.username)) {
      uniqueMap.set(user.username, { ...user }); 
    } else {
      const existing = uniqueMap.get(user.username);
      if (user.isBusy) existing.isBusy = true;
    }
  }
  return Array.from(uniqueMap.values());
}

/* ---------- AUTH ---------- */
app.post("/register", async (req, res) => {
  const { username, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.registerUser(username, email, hash, (err) => {
    if (err) return res.json({ success: false, message: "User exists" });
    res.json({ success: true });
  });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.getUserByUsername(username, async (err, results) => {
    if (err || results.length === 0) return res.json({ success: false, message: "Invalid credentials" });
    const valid = await bcrypt.compare(password, results[0].password_hash);
    if (!valid) return res.json({ success: false, message: "Invalid credentials" });
    const token = jwt.sign({ id: results[0].id, username: results[0].username }, SECRET, { expiresIn: "4h" });
    res.json({ success: true, token, username: results[0].username, avatar: results[0].avatar });
  });
});

/* ---------- FEEDS & INTERACTIONS ---------- */
app.get("/api/feeds", (req, res) => db.getFeeds((err, results) => res.json(results || [])));

app.post("/api/feeds/create", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    db.createFeed(decoded.username, req.body.image, req.body.caption, (err) => res.json({ success: !err }));
  } catch (e) { res.status(403).json({ success: false }); }
});

app.post("/api/feeds/like", (req, res) => db.likeFeed(req.body.feedId, req.body.username, () => res.json({ success: true })));

// Feed View / Read Count
app.post("/api/feeds/view", (req, res) => {
    const { feedId, username } = req.body;
    db.recordFeedView(feedId, username);
    res.json({ success: true });
});

// Feed Comments & Replies
app.get("/api/feeds/comments/:feedId", (req, res) => {
    db.getFeedComments(req.params.feedId, (err, results) => res.json(results || []));
});

app.post("/api/feeds/comment", (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    try {
        const decoded = jwt.verify(token, SECRET);
        db.addFeedComment(req.body.feedId, decoded.username, req.body.comment, (err) => res.json({ success: !err }));
    } catch (e) { res.status(403).json({ success: false }); }
});

app.post("/api/feeds/reply", (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    try {
        const decoded = jwt.verify(token, SECRET);
        db.addFeedReply(req.body.commentId, decoded.username, req.body.reply, (err) => res.json({ success: !err }));
    } catch (e) { res.status(403).json({ success: false }); }
});

/* ---------- AI & OTHERS ---------- */
app.post("/api/ai-chat", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false });

  try {
    const decoded = jwt.verify(token, SECRET);
    const { message } = req.body;
    const username = decoded.username;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!message) return res.json({ response: "Please say something!" });
    db.saveMessage(username, 'V-Chat AI', null, message, null, 'private');

    db.getAIChatHistory(username, async (err, results) => {
      let history = (results || []).reverse().map(row => ({
        role: row.sender === 'V-Chat AI' ? "model" : "user",
        parts: [{ text: row.message }]
      })).filter(h => h.parts[0].text !== message);
      history.push({ role: "user", parts: [{ text: message }] });

      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            systemInstruction: { parts: [{ text: "You are V-Chat AI, a helpful, warm AI assistant." }] },
            contents: history 
          })
        });
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm thinking...";
        db.saveMessage('V-Chat AI', username, null, text, null, 'private');
        res.json({ response: text });
      } catch (error) { res.json({ response: "AI service error." }); }
    });
  } catch (e) { res.status(403).json({ success: false }); }
});

app.get("/api/users", (req, res) => db.getAllUsers((err, results) => res.json(results || [])));

app.get("/api/groups", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    db.getGroupsForUser(decoded.username, (err, results) => res.json(results || []));
  } catch (e) { res.status(403).json([]); }
});

app.post("/api/groups/create", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    db.createGroup(req.body.name, decoded.username, (err) => res.json({ success: !err }));
  } catch (e) { res.status(403).json({ success: false }); }
});

/* ---------- MEETING & SOCKETS ---------- */
app.post("/api/create-meeting", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    const code = crypto.randomInt(100000000, 999999999).toString().replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3');
    db.createMeeting(code, decoded.username, (err) => res.json({ success: !err, code }));
  } catch (e) { res.status(403).json({ success: false }); }
});

app.post("/api/chat/history", (req, res) => db.getChatHistory(req.body.user1, req.body.user2, req.body.room, (err, results) => res.json(results || [])));

io.use((socket, next) => {
  try {
    const decoded = jwt.verify(socket.handshake.auth.token, SECRET);
    socket.username = decoded.username;
    socket.userId = decoded.id; 
    next();
  } catch (err) { next(new Error("Auth error")); }
});

io.on("connection", (socket) => {
  db.getUserAvatar(socket.userId, (err, results) => {
    onlineUsers.set(socket.id, { username: socket.username, isBusy: false, currentRoom: null, avatar: results?.[0]?.avatar });
    userSocketMap.set(socket.username, socket.id);
    io.emit("update-user-list", getUniqueOnlineUsers());
  });

  socket.on("initiate-call", (data) => {
    const targetId = userSocketMap.get(data.target);
    if (!targetId) return socket.emit("call-rejected", { from: "System", reason: "offline" });
    socket.to(targetId).emit("incoming-call", { from: socket.username, room: data.room, type: data.type, callMode: data.callMode });
  });

  socket.on("join", (data) => {
    socket.join(data.room);
    const user = onlineUsers.get(socket.id);
    if(user) { user.isBusy = true; user.currentRoom = data.room; }
    io.emit("update-user-list", getUniqueOnlineUsers());
    socket.to(data.room).emit("user-joined", { id: socket.id, username: socket.username });
  });

  socket.on("chat-message", (data) => {
    db.saveMessage(socket.username, null, data.room, data.text, data.image, 'group');
    socket.to(data.room).emit("chat-message", { ...data, sender: socket.username, time: new Date().toLocaleTimeString() });
  });

  socket.on("private-chat", (data) => {
    db.saveMessage(socket.username, data.to, null, data.text, data.image, 'private');
    const targetId = userSocketMap.get(data.to);
    if (targetId) socket.to(targetId).emit("private-chat", { ...data, sender: socket.username, time: new Date().toLocaleTimeString() });
    socket.emit("private-chat", { ...data, sender: socket.username, time: new Date().toLocaleTimeString() });
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(socket.id);
    userSocketMap.delete(socket.username);
    io.emit("update-user-list", getUniqueOnlineUsers());
  });
  
  socket.on("offer", (d) => socket.to(d.to).emit("offer", { offer: d.offer, from: socket.id, username: socket.username }));
  socket.on("answer", (d) => socket.to(d.to).emit("answer", { answer: d.answer, from: socket.id }));
  socket.on("ice", (d) => socket.to(d.to).emit("ice", { candidate: d.candidate, from: socket.id }));
});

server.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));