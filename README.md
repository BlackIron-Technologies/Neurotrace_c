# <img src="media/neurotrace-icon-light.svg#gh-light-mode-only" alt="NeuroTrace logo" height="62"><img src="media/neurotrace-icon-dark.svg#gh-dark-mode-only" alt="NeuroTrace logo" height="62"> NeuroTrace
 
 ### Local Reasoning Versioning for Developers
 
 > Your second brain in VS Code. Reasoning, notes, tasks and more linked to your code, stored 100% offline and secure. 
 
 ---
 
 ## ✨ What it looks like
 
 ### Sidebar with Thoughts
 
 ![Sidebar](media/sidebar-screenshot.png)
 
 ### Interactive Thought Graph
 
 ![Graph](media/graph-screenshot.png)
 
 ---
 
 ## 🚀 Why NeuroTrace?
 
 * Capture **hypotheses, decisions, insights, and tasks** right next to your code.
 * **Stay secure:** all reasoning is stored locally and encrypted by default.
 * **Boost productivity:** semantic search and graph visualization help you see patterns others miss.
 * Works **100% offline** — no cloud, no leaks, no distractions.


## 🆓 Free vs Premium

| Feature                                                    | Free Plan (Forever) | Premium (US$7.99/mo) |
| ---------------------------------------------------------- | ------------------- | -------------------- |
| Local Reasoning Log                                        | ✅                   | ✅                    |
| Inline Code Decorations                                    | ❌                   | ✅                    |
| Thought Limit                                              | ⚠️ **45/month**      | ✅ **Unlimited**      |
| Text Search                                                | ✅                   | ✅                    |
| Semantic Search (all-MiniLM-L6-v2 of SentenceTransformers) | ❌                   | ✅                    |
| Related Thought Suggestions                                | ❌                   | ✅                    |
| Interactive Thought Graph                                  | ❌                   | ✅                    |
| Encrypted Storage (AES-256)                                | ✅                   | ✅                    |
| Works Offline                                              | ✅                   | ✅                    |

---

## 🔒 Privacy & Security by Design

For maximum transparency, all security-critical code is open source in our [GitHub repository](https://github.com/BlackIron-Technologies/Neurotrace_c). You can verify that our privacy claims match our code.

* **100% Local:** Everything stays on your machine
* **Encrypted Storage:** SQLite + SQLCipher3 (AES-256 at rest)
* **Anonymous Telemetry:** Optional usage stats
* **Works Offline:** No cloud required

---

### 🛠️ Installation & Usage

1.  **Install from Marketplace**
    - Search for "NeuroTrace" in the Extensions panel (`Ctrl+Shift+X`).
    - Click **Install**.

2.  **Initialize in Your Workspace**
    - The NeuroTrace sidebar appears automatically after installation.
    - Click the "Initialize Database" button in the sidebar. This will create the local `.neurotrace` folder.

3.  **Add Your First Thought**
    - Open any code file.
    - Select your Snipet
    - Press `Alt+N` **or click the "+" button** in the NeuroTrace sidebar.
    - Fill in your idea and press Enter. You're all set!
 
   More details in [walkthrough/init.md](walkthrough/init.md)

🎉 Done! Your reasoning is now versioned locally.

---

## ✨ Premium Features & Account Management

### Accessing Premium Features

To unlock premium features like unlimited thoughts, semantic search, and the interactive thought graph:

1. **Open Advanced Settings:**
   - Use the Command Palette (`Ctrl+Shift+P`)
   - Run "NeuroTrace: Open Advanced Settings"
   - Or click the settings button in the NeuroTrace sidebar

2. **Sign in with GitHub:**
   - In Advanced Settings, click "Sign in with GitHub"
   - Complete the OAuth flow in your browser
   - Return to VS Code - you'll be automatically signed in

3. **Manage your account:**
   - View your authentication status
   - Subscribe to premium features
   - Sign out when needed

All account management is handled through the **Advanced Settings** panel for a clean, centralized experience.

---

## 💬 Support & Community

Need help or want to connect with other NeuroTrace users?

- 💬 **Discord**: [Join our community](https://discord.gg/your-discord-invite)
- 🐦 **X (Twitter)**: [@NeuroTraceVsc](https://x.com/NeuroTraceVsc)
- 📧 **Email**: neuro_support@blackironhq.com

We're here to help! Feel free to reach out with questions, suggestions, or feedback.

---

## 📄 License

NeuroTrace uses a **hybrid licensing model**: security-critical code is open source, while premium features remain proprietary. See [LICENSE.md](LICENSE.md) for complete terms.

---
> Version your reasoning.  🧠
> © 2025 BlackIron Technologies Ltd. All rights reserved.
---
