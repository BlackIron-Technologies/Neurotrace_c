// Test de rate limiting
const http = require('http');

async function testRateLimit() {
    const testData = {
        sessionId: "test-session",
        extensionVersion: "1.0.0",
        vscodeVersion: "1.80.0",
        platform: "Windows",
        weekStart: "2025-10-01",
        events: [{
            eventType: "thought_created",
            timestamp: new Date().toISOString(),
            anonymousId: "test-user"
        }],
        aggregatedStats: { totalThoughts: 1 }
    };

    console.log('🧪 Probando rate limiting (enviando 5 requests rápidos)...');

    for (let i = 0; i < 5; i++) {
        try {
            const postData = JSON.stringify(testData);

            const options = {
                hostname: 'localhost',
                port: 3000,
                path: '/api/telemetry',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    console.log(`Request ${i + 1}: Status ${res.statusCode}`);
                    if (res.statusCode !== 200) {
                        console.log(`  Respuesta: ${body}`);
                    }
                });
            });

            req.on('error', (e) => console.error(`Request ${i + 1} error:`, e.message));
            req.write(postData);
            req.end();

            // Pequeña pausa entre requests
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error(`Error en request ${i + 1}:`, error.message);
        }
    }
}

testRateLimit();