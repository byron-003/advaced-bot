const mysql = require("mysql2");

const db = mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "videochat"
});

// Initialize Database Tables
const initDB = () => {
  db.connect((err) => {
    if (err) {
      console.error("Database connection failed: " + err.stack);
      return;
    }
    console.log("Connected to MySQL");

    // Tables Definitions
    const schemas = [
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar LONGTEXT
      )`,
      `CREATE TABLE IF NOT EXISTS meetings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        host_username VARCHAR(255) NOT NULL,
        status ENUM('active', 'ended') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender VARCHAR(255) NOT NULL,
        receiver VARCHAR(255),
        room VARCHAR(255),
        message LONGTEXT, 
        image_data LONGTEXT,
        type ENUM('private', 'group') DEFAULT 'private',
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        username VARCHAR(255) NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_member (group_id, username)
      )`,
      `CREATE TABLE IF NOT EXISTS feeds (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255),
        image_data LONGTEXT,
        caption TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS feed_likes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        feed_id INT,
        username VARCHAR(255)
      )`,
      // NEW: Feed Comments
      `CREATE TABLE IF NOT EXISTS feed_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        feed_id INT NOT NULL,
        username VARCHAR(255) NOT NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      // NEW: Feed Replies
      `CREATE TABLE IF NOT EXISTS feed_replies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        comment_id INT NOT NULL,
        username VARCHAR(255) NOT NULL,
        reply TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      // NEW: Feed Views (Read Count)
      `CREATE TABLE IF NOT EXISTS feed_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        feed_id INT NOT NULL,
        username VARCHAR(255),
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    schemas.forEach(sql => db.query(sql, (err) => { if(err) console.error("Schema Error:", err); }));
  });
};

initDB();

// Exported Functions
module.exports = {
  // Auth
  registerUser: (username, email, hash, callback) => {
    db.query("INSERT INTO users (username, email, password_hash) VALUES (?,?,?)", [username, email, hash], callback);
  },
  getUserByUsername: (username, callback) => {
    db.query("SELECT * FROM users WHERE username=?", [username], callback);
  },
  getUserByEmail: (email, callback) => {
    db.query("SELECT * FROM users WHERE email = ?", [email], callback);
  },
  updateAvatar: (userId, avatar, callback) => {
    db.query("UPDATE users SET avatar = ? WHERE id = ?", [avatar, userId], callback);
  },
  getUserAvatar: (userId, callback) => {
    db.query("SELECT avatar FROM users WHERE id = ?", [userId], callback);
  },
  getAllUsers: (callback) => {
    db.query("SELECT username, id, avatar FROM users ORDER BY username ASC", callback);
  },

  // Feeds
  getFeeds: (callback) => {
    const query = `
      SELECT f.*, u.avatar, 
      (SELECT COUNT(*) FROM feed_likes WHERE feed_id = f.id) as likes,
      (SELECT COUNT(*) FROM feed_comments WHERE feed_id = f.id) as comment_count,
      (SELECT COUNT(*) FROM feed_views WHERE feed_id = f.id) as view_count
      FROM feeds f JOIN users u ON f.username = u.username 
      ORDER BY f.created_at DESC LIMIT 50`;
    db.query(query, callback);
  },
  createFeed: (username, image, caption, callback) => {
    db.query("INSERT INTO feeds (username, image_data, caption) VALUES (?, ?, ?)", [username, image, caption], callback);
  },
  likeFeed: (feedId, username, callback) => {
    db.query("INSERT IGNORE INTO feed_likes (feed_id, username) VALUES (?, ?)", [feedId, username], callback);
  },
  
  // NEW: Feed Interaction Logic
  recordFeedView: (feedId, username) => {
    db.query("INSERT INTO feed_views (feed_id, username) VALUES (?, ?)", [feedId, username || null]);
  },
  addFeedComment: (feedId, username, comment, callback) => {
    db.query("INSERT INTO feed_comments (feed_id, username, comment) VALUES (?, ?, ?)", [feedId, username, comment], callback);
  },
  addFeedReply: (commentId, username, reply, callback) => {
    db.query("INSERT INTO feed_replies (comment_id, username, reply) VALUES (?, ?, ?)", [commentId, username, reply], callback);
  },
  getFeedComments: (feedId, callback) => {
    const query = `
      SELECT c.*, u.avatar,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', r.id, 'username', r.username, 'reply', r.reply, 'created_at', r.created_at)) 
       FROM feed_replies r WHERE r.comment_id = c.id) as replies
      FROM feed_comments c 
      JOIN users u ON c.username = u.username
      WHERE c.feed_id = ? ORDER BY c.created_at ASC`;
    db.query(query, [feedId], callback);
  },

  // Groups
  getGroupsForUser: (username, callback) => {
    const query = `
      SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g JOIN group_members gm ON g.id = gm.group_id
      WHERE gm.username = ? ORDER BY g.created_at DESC
    `;
    db.query(query, [username], callback);
  },
  createGroup: (name, creator, callback) => {
    db.query("INSERT INTO groups (name, created_by) VALUES (?, ?)", [name, creator], (err, result) => {
      if (err) return callback(err);
      const groupId = result.insertId;
      db.query("INSERT INTO group_members (group_id, username) VALUES (?, ?)", [groupId, creator], (err2) => {
        callback(err2, result);
      });
    });
  },
  addGroupMember: (groupId, username, callback) => {
    db.query("SELECT id FROM users WHERE username = ?", [username], (err, results) => {
      if (err || results.length === 0) return callback(new Error("User not found"));
      db.query("INSERT IGNORE INTO group_members (group_id, username) VALUES (?, ?)", [groupId, username], callback);
    });
  },

  // Meetings
  createMeeting: (code, host, callback) => {
    db.query("INSERT INTO meetings (code, host_username, status) VALUES (?, ?, 'active')", [code, host], callback);
  },
  validateMeeting: (code, callback) => {
    db.query("SELECT * FROM meetings WHERE code = ? AND status = 'active'", [code], callback);
  },
  endMeeting: (code) => {
    db.query("UPDATE meetings SET status = 'ended' WHERE code = ?", [code]);
  },

  // Messaging
  saveMessage: (sender, receiver, room, message, image, type) => {
    db.query("INSERT INTO messages (sender, receiver, room, message, image_data, type) VALUES (?, ?, ?, ?, ?, ?)", 
      [sender, receiver || null, room || null, message, image || null, type]);
  },
  getChatHistory: (user1, user2, room, callback) => {
    if (room) {
      const query = `SELECT m.*, u.avatar FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE m.room = ? ORDER BY m.created_at ASC`;
      db.query(query, [room], callback);
    } else {
      const query = `SELECT m.*, u.avatar FROM messages m LEFT JOIN users u ON m.sender = u.username 
                     WHERE (m.sender = ? AND m.receiver = ?) OR (m.sender = ? AND m.receiver = ?) 
                     ORDER BY m.created_at ASC`;
      db.query(query, [user1, user2, user2, user1], callback);
    }
  },
  getAIChatHistory: (username, callback) => {
    const query = `SELECT sender, message FROM messages WHERE (sender = ? AND receiver = 'V-Chat AI') OR (sender = 'V-Chat AI' AND receiver = ?) ORDER BY created_at DESC LIMIT 20`;
    db.query(query, [username, username], callback);
  }
};