const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://cloudaistudio@localhost/nexus_forum?sslmode=disable',
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize database
async function initDB() {
  try {
    console.log('Initializing database...');
    console.log('Database URL:', process.env.DATABASE_URL ? 'Connected to Neon' : 'Using local DB');
    
    // Test connection
    await pool.query('SELECT 1');
    console.log('Database connection successful');
    
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url VARCHAR(255),
        bio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Categories table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        color VARCHAR(7) DEFAULT '#667eea',
        icon VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Topics table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS topics (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id),
        category_id INTEGER REFERENCES categories(id),
        views INTEGER DEFAULT 0,
        is_pinned BOOLEAN DEFAULT FALSE,
        is_locked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Posts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        parent_id INTEGER REFERENCES posts(id),
        likes INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Likes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        post_id INTEGER REFERENCES posts(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, post_id)
      )
    `);

    // Insert default categories
    await pool.query(`
      INSERT INTO categories (name, description, color, icon)
      VALUES 
        ('General Discussion', 'Talk about anything related to our community', '#667eea', 'chat'),
        ('Announcements', 'Important updates and news', '#f56565', 'megaphone'),
        ('Help & Support', 'Get help from the community', '#48bb78', 'help-circle'),
        ('Feature Requests', 'Suggest new features and improvements', '#ed8936', 'lightbulb')
      ON CONFLICT DO NOTHING
    `);

    // Create admin user
    const adminPassword = await bcrypt.hash('admin123', 10);
    await pool.query(`
      INSERT INTO users (username, email, password_hash, bio)
      VALUES ('admin', 'admin@nexus.com', $1, 'Forum Administrator')
      ON CONFLICT (username) DO NOTHING
    `, [adminPassword]);

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM categories');
    res.json({ 
      status: 'healthy',
      database: 'connected',
      categories: result.rows[0].count
    });
  } catch (err) {
    res.json({ 
      status: 'unhealthy',
      database: 'error',
      error: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
  }
});

// Auth endpoints
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hash]
    );
    
    const token = jwt.sign(
      { id: result.rows[0].id, username: result.rows[0].username },
      process.env.JWT_SECRET || 'nexus-secret-key',
      { expiresIn: '7d' }
    );
    
    res.json({ user: result.rows[0], token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Update last seen
    await pool.query('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    
    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET || 'nexus-secret-key',
      { expiresIn: '7d' }
    );
    
    res.json({ 
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
        bio: user.bio
      },
      token 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, COUNT(DISTINCT t.id) as topic_count
      FROM categories c
      LEFT JOIN topics t ON c.id = t.category_id
      GROUP BY c.id
      ORDER BY c.id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Topics
app.get('/api/topics', async (req, res) => {
  const { category, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  
  try {
    let query = `
      SELECT 
        t.*,
        u.username,
        u.avatar_url,
        c.name as category_name,
        c.color as category_color,
        COUNT(DISTINCT p.id) as post_count,
        MAX(p.created_at) as last_post_at
      FROM topics t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN posts p ON p.topic_id = t.id
    `;
    
    const params = [];
    if (category) {
      query += ' WHERE t.category_id = $1';
      params.push(category);
    }
    
    query += `
      GROUP BY t.id, u.username, u.avatar_url, c.name, c.color
      ORDER BY t.is_pinned DESC, t.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single topic
app.get('/api/topics/:id', async (req, res) => {
  try {
    // Increment view count
    await pool.query('UPDATE topics SET views = views + 1 WHERE id = $1', [req.params.id]);
    
    const topicResult = await pool.query(`
      SELECT 
        t.*,
        u.username,
        u.avatar_url,
        u.bio as user_bio,
        c.name as category_name,
        c.color as category_color
      FROM topics t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.id = $1
    `, [req.params.id]);
    
    if (topicResult.rows.length === 0) {
      return res.status(404).json({ error: 'Topic not found' });
    }
    
    res.json(topicResult.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create topic
app.post('/api/topics', async (req, res) => {
  const { title, content, category_id, user_id } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO topics (title, content, category_id, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, content, category_id, user_id || 1]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get posts for topic
app.get('/api/topics/:id/posts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.*,
        u.username,
        u.avatar_url,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.topic_id = $1
      ORDER BY p.created_at ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create post
app.post('/api/posts', async (req, res) => {
  const { content, topic_id, user_id, parent_id } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO posts (content, topic_id, user_id, parent_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [content, topic_id, user_id || 1, parent_id]
    );
    
    // Update topic's updated_at
    await pool.query('UPDATE topics SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [topic_id]);
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Like/Unlike post
app.post('/api/posts/:id/like', async (req, res) => {
  const { user_id } = req.body;
  const post_id = req.params.id;
  
  try {
    // Check if already liked
    const existing = await pool.query(
      'SELECT * FROM likes WHERE user_id = $1 AND post_id = $2',
      [user_id || 1, post_id]
    );
    
    if (existing.rows.length > 0) {
      // Unlike
      await pool.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [user_id || 1, post_id]);
      await pool.query('UPDATE posts SET likes = likes - 1 WHERE id = $1', [post_id]);
      res.json({ liked: false });
    } else {
      // Like
      await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1, $2)', [user_id || 1, post_id]);
      await pool.query('UPDATE posts SET likes = likes + 1 WHERE id = $1', [post_id]);
      res.json({ liked: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as user_count,
        (SELECT COUNT(*) FROM topics) as topic_count,
        (SELECT COUNT(*) FROM posts) as post_count,
        (SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '24 hours') as active_users
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, async () => {
  await initDB();
  console.log(`Nexus Forum running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view the forum`);
});
