const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory data store (for demo)
let topics = [];
let categories = [
  { id: 1, name: 'General Discussion', description: 'Talk about anything', color: '#667eea', topic_count: 0 },
  { id: 2, name: 'Announcements', description: 'Important updates', color: '#f56565', topic_count: 0 },
  { id: 3, name: 'Help & Support', description: 'Get help from the community', color: '#48bb78', topic_count: 0 },
  { id: 4, name: 'Feature Requests', description: 'Suggest new features', color: '#ed8936', topic_count: 0 }
];

let topicIdCounter = 1;
let users = [{ id: 1, username: 'admin', email: 'admin@nexus.com' }];

// Routes
app.get('/api/stats', (req, res) => {
  res.json({
    topic_count: topics.length,
    post_count: topics.reduce((sum, t) => sum + (t.post_count || 0), 0),
    user_count: users.length,
    active_users: 1
  });
});

app.get('/api/categories', (req, res) => {
  res.json(categories);
});

app.get('/api/topics', (req, res) => {
  const { category } = req.query;
  let filteredTopics = category 
    ? topics.filter(t => t.category_id === parseInt(category))
    : topics;
  
  res.json(filteredTopics.sort((a, b) => b.created_at - a.created_at));
});

app.post('/api/topics', (req, res) => {
  const { title, content, category_id } = req.body;
  const newTopic = {
    id: topicIdCounter++,
    title,
    content,
    category_id: parseInt(category_id),
    user_id: 1,
    username: 'You',
    views: 0,
    post_count: 0,
    created_at: new Date(),
    category_name: categories.find(c => c.id === parseInt(category_id))?.name,
    category_color: categories.find(c => c.id === parseInt(category_id))?.color
  };
  
  topics.push(newTopic);
  
  // Update category count
  const category = categories.find(c => c.id === parseInt(category_id));
  if (category) category.topic_count++;
  
  res.json(newTopic);
});

// Start server
app.listen(PORT, () => {
  console.log(`Nexus Forum (Simple Version) running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view the forum`);
  console.log('This is using in-memory storage - data will reset on restart');
});
