# <img src="../media/neurotrace-icon-light.svg#gh-light-mode-only" alt="NeuroTrace logo" height="62"><img src="../media/neurotrace-icon-dark.svg#gh-dark-mode-only" alt="NeuroTrace logo" height="62"> NeuroTrace Anonymous Telemetry

## Overview

NeuroTrace's telemetry system collects anonymous usage data to help improve the extension. All data is completely anonymous and contains no personal information or content from your thoughts.

## What data is collected?

### Tracked events:
- **thought_created**: When a new thought is created
  - Thought type (hypothesis, decision, insight, etc.)
  - Whether it includes code or an associated file
  - Whether it has tags
- **graph_opened**: When the graph visualization panel is opened
- **suggest_related_used**: When the "Suggest Related" function is used
- **semantic_search_used**: When a semantic search is performed
  - Search term length
  - Number of results found
- **semantic_ai_graph_used**: When semantic view is toggled on/off in the graph

### System metadata:
- Extension version
- VS Code version
- System platform (Windows, macOS, Linux)
- Anonymous unique ID (randomly generated)
- Week start date
- Aggregated usage statistics

## Privacy and Anonymity

### What is NOT collected:
- ❌ Content of your thoughts
- ❌ File names or paths
- ❌ Source code
- ❌ Personal information
- ❌ IP addresses (hashed before storing)
- ❌ Usernames or personal identifiers

### Privacy measures:
- ✅ All IDs are hashed with SHA-256
- ✅ Data is aggregated weekly before sending
- ✅ Textual content is never included
- ✅ Only usage statistics are sent
- ✅ Completely respects user configuration

## User Control

### Enable/Disable:
1. Open NeuroTrace's "Advanced Settings" panel
2. Check or uncheck the "Enable Telemetry" box
3. Changes take effect immediately

### When disabled:
- No data of any kind is collected
- Existing data is automatically deleted
- No connections are made to the telemetry server

## Technical Operation

### Local Collection:
- Events are stored locally in a JSON file
- Usage statistics are aggregated during the week
- Data is maintained in VS Code's global storage

### Weekly Submission:
- Data is automatically sent every Monday at 00:00 UTC
- After successful submission, local data is cleaned
- If submission fails, it retries the following week

### Server Processing:
- Data is additionally sanitized on the server
- Stored in JSON files with unique timestamps
- Aggregated statistics are generated for analysis

## Benefits for Users

Telemetry data helps us:
- 📊 Understand which functions are most used
- 🐛 Identify common problems and errors
- 🚀 Prioritize improvements and new features
- 📈 Optimize extension performance
- 🎯 Improve user experience

## Transparency

### Open Source:
- All telemetry code is available for review in the [GitHub repository](https://your_repository_url)
- Anonymization algorithms are public
- The telemetry server is open source

### Reports:
- Aggregated statistics may be shared publicly
- Data is never sold or shared with third parties
- A transparent record of collected data is maintained

## Compliance

### Regulations:
- ✅ GDPR compliant (completely anonymous data)
- ✅ CCPA compliant (no personal data)
- ✅ Privacy Act 2020 (New Zealand) compliant
- ✅ Respects privacy best practices

## Contact

If you have questions about telemetry or privacy:
- Open an issue in the GitHub repository
- Telemetry data can be reviewed at any time
- Improvement suggestions are welcome

---

*Telemetry is completely optional and respects your privacy. Your content and personal data are never collected.*

---
© 2025 BlackIron Technologies Ltd. All rights reserved.