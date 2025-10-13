const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();

// Configuration from environment variables
const PORT = process.env.PORT || 3000; // Changed default port for security
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'telemetry_data');
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security: Disable Express headers in production
if (NODE_ENV === 'production') {
    app.disable('x-powered-by');
}

// Security middleware
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting (simple in-memory implementation)
const requestCounts = new Map();
const RATE_LIMIT = 100; // requests per hour per IP
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

function rateLimit(req, res, next) {
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    if (!requestCounts.has(clientIP)) {
        requestCounts.set(clientIP, { count: 1, windowStart: now });
        return next();
    }

    const clientData = requestCounts.get(clientIP);

    // Reset window if expired
    if (now - clientData.windowStart > RATE_WINDOW) {
        clientData.count = 1;
        clientData.windowStart = now;
        return next();
    }

    // Check rate limit
    if (clientData.count >= RATE_LIMIT) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please try again later.'
        });
    }

    clientData.count++;
    next();
}

app.use(express.json({
    limit: '1mb', // Reduced from 10mb for security
    strict: true
}));

// Apply rate limiting to telemetry endpoint
app.use('/api/telemetry', rateLimit);

// Ensure data directory exists
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        console.error('Failed to create data directory:', error);
    }
}

// Input sanitization function
function sanitizeInput(input) {
    if (typeof input === 'string') {
        // Remove potential XSS and injection attempts
        return input.replace(/[<>\"'&]/g, '').slice(0, 1000); // Limit string length
    }
    return input;
}

// Validate telemetry data structure
function validateTelemetryData(data) {
    // Check data size
    const dataString = JSON.stringify(data);
    if (dataString.length > 500000) { // 500KB limit
        return { valid: false, error: 'Data payload too large' };
    }

    const requiredFields = ['sessionId', 'extensionVersion', 'vscodeVersion', 'platform', 'weekStart', 'events', 'aggregatedStats'];

    for (const field of requiredFields) {
        if (!(field in data)) {
            return { valid: false, error: `Missing required field: ${field}` };
        }
    }

    if (!Array.isArray(data.events)) {
        return { valid: false, error: 'Events must be an array' };
    }

    // Limit number of events
    if (data.events.length > 1000) {
        return { valid: false, error: 'Too many events in single submission' };
    }

    // Validate each event
    for (const event of data.events) {
        if (!event.eventType || !event.timestamp || !event.anonymousId) {
            return { valid: false, error: 'Invalid event structure' };
        }

        // Sanitize event fields
        event.eventType = sanitizeInput(event.eventType);
        event.anonymousId = sanitizeInput(event.anonymousId);

        const validEventTypes = [
            'thought_created',
            'graph_opened',
            'suggest_related_used',
            'semantic_search_used',
            'semantic_ai_graph_used'
        ];

        if (!validEventTypes.includes(event.eventType)) {
            return { valid: false, error: `Invalid event type: ${event.eventType}` };
        }
    }

    return { valid: true };
}

// Sanitize data to ensure anonymity
function sanitizeTelemetryData(data) {
    const sanitized = {
        ...data,
        events: data.events.map(event => ({
            eventType: event.eventType,
            timestamp: event.timestamp,
            anonymousId: hashAnonymousId(event.anonymousId), // Hash the anonymous ID for extra privacy
            metadata: event.metadata ? sanitizeMetadata(event.metadata) : undefined
        }))
    };

    // Remove any potentially identifying information
    delete sanitized.sessionId; // We don't need to store the session ID

    return sanitized;
}

function hashAnonymousId(anonymousId) {
    return crypto.createHash('sha256').update(anonymousId).digest('hex').substring(0, 16);
}

function sanitizeMetadata(metadata) {
    const sanitized = {};

    // Only keep safe metadata fields
    const safeFields = [
        'thoughtType',
        'hasCodeSnippet',
        'searchTermLength',
        'resultCount'
    ];

    for (const field of safeFields) {
        if (field in metadata) {
            sanitized[field] = metadata[field];
        }
    }

    return sanitized;
}

// Generate filename based on submission date
function generateFilename() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').split('T')[0];
    const random = crypto.randomBytes(4).toString('hex');
    return `telemetry_${timestamp}_${random}.json`;
}

// Main telemetry endpoint
app.post('/api/telemetry', async (req, res) => {
    try {
        // Validate content type
        if (!req.is('application/json')) {
            return res.status(400).json({
                success: false,
                error: 'Content-Type must be application/json'
            });
        }

        console.log('Received telemetry submission');

        // Validate the data
        const validation = validateTelemetryData(req.body);
        if (!validation.valid) {
            console.error('Validation failed:', validation.error);
            return res.status(400).json({
                success: false,
                error: 'Invalid data format' // Generic error message for security
            });
        }

        // Sanitize the data
        const sanitizedData = sanitizeTelemetryData(req.body);

        // Add server-side metadata
        const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
        const processedData = {
            ...sanitizedData,
            receivedAt: new Date().toISOString(),
            serverVersion: process.env.SERVER_VERSION || '1.0.0',
            ipHash: hashAnonymousId(clientIP + process.env.IP_SALT || 'default-salt'), // Salted hash for extra security
        };

        // Save to file
        const filename = generateFilename();
        const filepath = path.join(DATA_DIR, filename);

        await fs.writeFile(filepath, JSON.stringify(processedData, null, 2));

        // Secure logging (no sensitive data)
        console.log(`Telemetry data saved, events: ${processedData.events.length}, timestamp: ${new Date().toISOString()}`);

        res.json({
            success: true,
            message: 'Telemetry data received successfully',
            eventsProcessed: processedData.events.length,
            fileId: filename.split('.')[0] // Return filename without extension as ID
        });

    } catch (error) {
        console.error('Error processing telemetry:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'Anonymous Telemetry Service',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// Statistics endpoint (for internal monitoring)
app.get('/api/stats', async (req, res) => {
    try {
        const files = await fs.readdir(DATA_DIR);
        const telemetryFiles = files.filter(f => f.startsWith('telemetry_') && f.endsWith('.json'));

        let totalEvents = 0;
        let totalSubmissions = telemetryFiles.length;
        const eventTypes = {};
        const platforms = {};
        const versions = {};

        // Aggregate statistics from all files
        for (const file of telemetryFiles.slice(-50)) { // Last 50 submissions only
            try {
                const content = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
                const data = JSON.parse(content);

                totalEvents += data.events.length;

                // Count event types
                for (const event of data.events) {
                    eventTypes[event.eventType] = (eventTypes[event.eventType] || 0) + 1;
                }

                // Count platforms
                platforms[data.platform] = (platforms[data.platform] || 0) + 1;

                // Count extension versions
                versions[data.extensionVersion] = (versions[data.extensionVersion] || 0) + 1;

            } catch (error) {
                console.error(`Error reading file ${file}:`, error);
            }
        }

        res.json({
            totalSubmissions,
            totalEvents,
            eventTypes,
            platforms,
            versions,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error generating stats:', error);
        res.status(500).json({ error: 'Failed to generate statistics' });
    }
});

// Start server
async function startServer() {
    await ensureDataDir();

    app.listen(PORT, () => {
        console.log(`Anonymous Telemetry Service running on port ${PORT}`);
        console.log(`Data directory: ${DATA_DIR}`);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down telemetry service...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down telemetry service...');
    process.exit(0);
});

startServer().catch(console.error);