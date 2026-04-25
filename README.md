# Athernex BMS

Arduino + Wokwi hardware development workspace with AI-assisted ideation, component planning, circuit design, and firmware iteration.

## What This Project Includes

- Backend API for project, ideation, components, design, compile, and voice flows
- Frontend workspace for chatting with AI, generating files, and iterating hardware logic
- Wokwi simulation integration (`diagram.json` + `.ino`) workflows
- Registry-driven component and code generation pipeline

## Project Structure

- `backend/` Node.js + Express API and hardware generation services
- `frontend/` React + Vite application
- `backend/data/` component registry, presets, and generated support data
- `backend/wokwi-smoke*` simulation smoke-test assets

## Local Setup

### Backend

```bash
cd backend
npm install
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Environment

Create and configure `backend/.env` with required API keys and runtime variables.

## Notes

- Wokwi and Arduino flows depend on valid local tooling/configuration.
- Voice features depend on configured STT/TTS providers.

## License

Project license and usage terms are defined by the repository owner.