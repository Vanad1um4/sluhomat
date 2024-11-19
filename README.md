# Sluhomat-3000 tg bot

A Telegram bot for transcribing voice messages and audio files into text using the OpenAI Whisper API.

## Features

- Voice message transcription
- Audio file transcription
- User authorization system
- Support for various audio formats

## Installation

1. Clone the repository:

```bash
git clone https://github.com/Vanad1um4/sluhomat.git
cd sluhomat
```

2. Install dependencies:

```bash
npm install
```

3. Create configuration file:

```bash
cp env.js.example env.js
```

4. Edit `env.js` and add:

- Your Telegram bot token (`TG_BOT_KEY`)
- OpenAI API key (`OPENAI_API_KEY`)
- List of authorized users (`INIT_USERS`)

## Running

To start the bot:

```bash
npm start
```

To run in development mode:

```bash
npm run dev
```

## Usage

1. Add users to the `INIT_USERS` array in `env.js`
2. Start the bot
3. Send the `/start` command to get instructions
4. Send a voice message or audio file for transcription

## Project Structure

```
sluhomat/
├── bot/
│   ├── audio_handler.js  # Audio processing
│   └── commands.js       # Bot commands
├── db/
│   ├── db.js             # DB connection
│   ├── init.js           # DB initialization
│   └── users.js          # User management
├── bot.js                # Main bot file
├── const.js              # Constants
├── env.js                # Configuration
└── utils.js              # Utilities
```

## Technologies

- Node.js
- Telegraf
- OpenAI Whisper API
- SQLite
