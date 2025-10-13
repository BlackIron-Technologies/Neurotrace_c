# NeuroTrace Telemetry Server - Open Source Audit Version

## 🔍 Purpose

This repository contains the **complete telemetry server code** used by the NeuroTrace VS Code extension for **transparency and audit purposes**. This is **NOT** intended for production deployment.

## 📊 What This Server Does

- Collects **anonymous usage statistics** from NeuroTrace extension users
- Validates and sanitizes all incoming telemetry data
- Stores data locally with **privacy-first approach**
- Provides basic statistics for development insights

## 🔒 Privacy & Security Features

### Data Anonymization:
- ✅ Anonymous IDs are **double-hashed** (SHA-256)
- ✅ Session IDs are **removed** before storage
- ✅ IP addresses are **hashed** 
- ✅ Only safe metadata fields are kept
- ✅ No personal identifiers are stored

### Data Validation:
- ✅ Strict schema validation for all incoming data
- ✅ Event type whitelist (only predefined events accepted)
- ✅ Input size limits (10MB max)
- ✅ Malformed data rejection

## 📁 Repository Structure

```
├── telemetry_server.js      # Main server code
├── package.json             # Dependencies and configuration
├── TELEMETRY_GUIDE.md       # Complete documentation
├── start_telemetry.sh       # Linux/Mac startup script
├── start_telemetry.bat      # Windows startup script
└── README_OPENSOURCE.md     # This file
```

## 🛡️ What Data Is Collected

### Event Types Tracked:
- `thought_created` - When users create new thoughts
- `graph_opened` - When the thought graph is viewed
- `suggest_related_used` - When related suggestions are used
- `semantic_search_used` - When semantic search is performed
- `semantic_ai_graph_used` - When AI graph features are used

### Metadata Collected (anonymized):
- Extension version
- VS Code version  
- Platform (Windows/Mac/Linux)
- Event timestamps
- Anonymous usage patterns

### What Is NOT Collected:
- ❌ User names or identifiers
- ❌ File paths or code content
- ❌ Personal information
- ❌ Thought content or text
- ❌ Search queries or terms

## 🏗️ Technical Implementation

### Stack:
- **Node.js** with Express
- **CORS** enabled for cross-origin requests
- **JSON** file-based storage
- **Crypto** module for hashing

### Endpoints:
- `POST /api/telemetry` - Receives telemetry data
- `GET /api/health` - Health check
- `GET /api/stats` - Usage statistics (aggregated)

### Security Measures:
- Request size limits
- Data validation & sanitization
- Hash-based anonymization
- No database storage (files only)

## 🔧 For Auditors

### To Review This Code:

1. **Install dependencies**: `npm install`
2. **Review main server**: Check `telemetry_server.js`
3. **Check data handling**: Review sanitization functions
4. **Verify privacy**: Confirm no PII is stored
5. **Test endpoints**: Use provided scripts

### Key Functions to Audit:
- `validateTelemetryData()` - Input validation
- `sanitizeTelemetryData()` - Data cleaning
- `hashAnonymousId()` - ID anonymization
- `sanitizeMetadata()` - Metadata filtering

## 📞 Contact

This code is provided for transparency. If you have questions about our telemetry practices, please open an issue in this repository.

## ⚠️ Important Notes

- This repository is for **audit purposes only**
- Do **NOT** use this code for production deployment
- The actual production server may have additional security measures
- No real telemetry data is included in this repository

---
**License**: MIT (for audit and review purposes)