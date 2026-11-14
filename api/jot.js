// Vercel serverless function: delegates to the shared router in server.js
module.exports = require('../server').handleApi;
module.exports.config = { api: { bodyParser: false } };
