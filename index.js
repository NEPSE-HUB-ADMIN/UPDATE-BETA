// index.js — Entry point for Render deployment
import express from 'express';
import cors from 'cors';
import alphaBetaHandler from './api/alpha-beta.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['X-CSRF-Token', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Content-Type', 'Date', 'X-Api-Version', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Request Logger ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health Check
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'NEPSTRAT Alpha/Beta API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: [
            { method: 'GET', path: '/', description: 'Health check' },
            { method: 'GET', path: '/health', description: 'Health check' },
            { method: 'GET', path: '/api/alpha-beta?symbol=NABIL', description: 'Get Alpha/Beta for a stock' },
            { method: 'GET', path: '/api/alpha-beta?symbol=NABIL&force=true', description: 'Force refresh Alpha/Beta' },
            { method: 'GET', path: '/api/alpha-beta?symbol=NABIL&days=90', description: 'Custom lookback period' }
        ]
    });
});

// Health Check (alternative)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// ─── Alpha/Beta API ──────────────────────────────────────────────────────────
app.get('/api/alpha-beta', async (req, res) => {
    console.log(`[Alpha/Beta] Request received:`, req.query);
    try {
        await alphaBetaHandler(req, res);
    } catch (error) {
        console.error('[Alpha/Beta] Handler error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.path
    });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`🚀 NEPSTRAT Alpha/Beta API Server`);
    console.log(`📡 Running on: http://localhost:${PORT}`);
    console.log(`🕐 Started at: ${new Date().toISOString()}`);
    console.log(`📊 Endpoints:`);
    console.log(`   GET  /                          - Health check`);
    console.log(`   GET  /health                    - Health check`);
    console.log(`   GET  /api/alpha-beta?symbol=NABIL - Alpha/Beta calculation`);
    console.log('═══════════════════════════════════════════════════════════');
});
