# ⛪ Church Real-Time Translation System

A system that translates Korean sermons into Japanese in real time and displays them on visitors' phones.

🌐 Languages: [한국어](README.md) | [日本語](README.ja.md) | [English](README.en.md)

---

## ✨ Features

- 🎤 Real-time Korean → Japanese speech translation
- 📱 Connect via QR code or direct link from phone
- 🔐 6-digit PIN protected access
- ⚡ Three translation speed modes (Super Fast / Quick / Precise)
- 🈂️ Furigana (hiragana above kanji) display option
- 🇰🇷 Option to display original Korean text alongside translation
- 📜 Teleprompter-style auto-scrolling display
- 🎙️ Support for various audio input devices (microphone, mixer, USB audio, etc.)
- 📋 Real-time system log monitoring
- 🌐 Accessible even without being on the same Wi-Fi (via Cloudflare Tunnel)

---

## 📋 Requirements

- Mac OS (Sox and LibreOffice related features are Mac-only)
- [Node.js](https://nodejs.org) (v18 or higher)
- [OpenAI API key](https://platform.openai.com)
- Homebrew (Mac package manager)

---

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/davidim22/stt_summercamp_2026.git
cd stt_summercamp_2026
```

### 2. Install packages

```bash
npm install
```

### 3. Install required programs

```bash
brew install sox
brew install cloudflare/cloudflare/cloudflared
```

### 4. Set up environment variables

Create a `.env` file and add your API key:

```bash
nano .env
```

Add the following:

```
OPENAI_API_KEY=your_api_key_here
```

Save: `Ctrl+X` → `Y` → `Enter`

> ⚠️ **Important**: Never upload the `.env` file to GitHub. If your API key is exposed, others could use it and charge costs to your account.

### 5. Run the server

```bash
node server.js
```

The browser will open automatically, showing the `localhost:3000/control` page.

---

## 💻 How to Use

### Operator (Control Panel)

1. When the server starts, the control panel opens automatically
2. In 🎙️ **Audio Input Settings**, select and test the microphone or mixer you want to use
3. Check the connection link and PIN in the 📱 **QR Code** section
4. Press **Start Translation** in 🎤 **Translation Controls** to begin (API charges start from this point)
5. When the sermon ends, press **Stop Translation** to stop the charges

### Visitor (Phone)

1. Scan the QR code or enter the link directly
2. Enter the PIN number (ask the operator)
3. View the real-time Japanese translation
4. Use the buttons at the bottom of the screen to adjust font size, toggle original text, and toggle furigana

---

## ⌨️ Control Panel Functions

| Button | Function |
|---|---|
| ▶ Start Translation | Starts mic and translation connection (API charges begin) |
| ⏹ Stop Translation | Completely stops mic and translation connection (API charges stop) |
| 📢 Show Subtitles | Shows subtitles on phones (no effect on cost) |
| 🔇 Hide Subtitles | Hides subtitles on phones (no effect on cost) |
| 🚀 Super Fast | Displays text instantly character by character (fastest, slightly rough) |
| ⚡ Quick | Displays text smoothly word by word (fast and readable) |
| 🎯 Precise | Displays complete sentences (most accurate, slightly slower) |
| 🔄 Regenerate PIN | Generates a new access PIN (disconnects current viewers) |

---

## 📱 Phone Screen Functions

| Button | Function |
|---|---|
| A- / A / A+ | Adjust font size (saved per device) |
| KO | Toggle Korean original text on/off |
| ふ | Toggle furigana (hiragana above kanji) on/off |
| 🗑️ Clear All | Clears the accumulated translation history on screen |

All settings are saved individually on each phone, so multiple people can connect at the same time with different personal settings.

---

## 💰 API Cost

Based on OpenAI's `gpt-realtime-translate` model:

```
$0.034 / minute

45-minute sermon ≈ $1.53
3-day camp (2 sessions/day) ≈ $9.18
```

Charges only apply while **Start Translation** is active. No charges occur when **Stop Translation** is used. (Note: **Hide Subtitles** keeps the mic connection active, so charges continue — use **Stop Translation** to fully stop costs.)

Set a spending limit at: [platform.openai.com](https://platform.openai.com) → Billing → Usage limits

---

## 🛠️ Tech Stack

- **Backend**: Node.js + Express
- **Translation**: OpenAI `gpt-realtime-translate` (WebSocket)
- **Real-time delivery**: Server-Sent Events (SSE)
- **Audio capture**: Sox
- **Furigana conversion**: Kuroshiro + Kuromoji
- **External access**: Cloudflare Tunnel (with ngrok as backup)
- **QR code generation**: qrcode package

---

## ⚠️ Important Notes

- Never upload the `.env` file to GitHub
- Each user needs their own OpenAI API key
- Works only on Mac OS (uses Sox, system_profiler)
- Requires a stable internet connection
- If Cloudflare Tunnel connection fails, access is limited to the same Wi-Fi network

---

## 🐛 Troubleshooting

| Issue | Solution |
|---|---|
| Port 3000 already in use | `lsof -ti:3000 \| xargs kill -9` |
| Sox not found | `brew install sox` |
| Microphone volume too low | Select a different device in audio input settings, or check mic volume |
| Phone won't connect | Verify the PIN is correct, or try refreshing the QR code |
| Translation appears in wrong language | Check your API key and try restarting the server |
| API key error | Make sure OPENAI_API_KEY is correctly set in the `.env` file |

---

## 📝 License

MIT License — Free to use for non-commercial ministry purposes.

Copyright (c) 2026
