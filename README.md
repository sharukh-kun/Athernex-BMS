<h1 align="left">NovaAi</h1>

<p align="center">
	<a href="#"><img src="https://img.shields.io/badge/version-1.0.0-0ea5e9" alt="Version" /></a>
	<a href="#"><img src="https://img.shields.io/badge/backend-Node.js%20%2B%20Express-3c873a" alt="Backend" /></a>
	<a href="#"><img src="https://img.shields.io/badge/frontend-React%20%2B%20Vite-2563eb" alt="Frontend" /></a>
	<a href="#"><img src="https://img.shields.io/badge/simulation-Wokwi-f59e0b" alt="Simulation" /></a>
	<a href="#license"><img src="https://img.shields.io/badge/license-Repository%20Owner%20Defined-84cc16" alt="License" /></a>
</p>

<h3 align="center">A modern AI-assisted hardware prototyping workspace for Arduino + Wokwi</h3>

<p align="center">
	<a href="#core-features">Features</a>
	• <a href="#local-setup">Installation</a>
	• <a href="#documentation">Documentation</a>
	• <a href="#support">Support</a>
	• <a href="#contributing">Contributing</a>
</p>

<p align="center">
	<img src="https://img.shields.io/badge/status-active-22c55e" alt="Status" />
	<img src="https://img.shields.io/badge/platform-Web%20App%20%7C%20API-64748b" alt="Platform" />
	<img src="https://img.shields.io/badge/domain-Embedded%20AI%20Prototyping-0891b2" alt="Domain" />
</p>

Arduino + Wokwi hardware development workspace with AI-assisted ideation, component planning, circuit design, and firmware iteration.

NovaAi helps makers and teams go from a plain idea to a runnable embedded prototype faster. The platform combines conversational AI, component intelligence, board-aware generation, and simulation-ready exports so users can iterate on electronics projects without constantly switching tools.

## What This Project Includes

- Backend API for project, ideation, components, design, compile, and voice flows
- Frontend workspace for chatting with AI, generating files, and iterating hardware logic
- Wokwi simulation integration (`diagram.json` + `.ino`) workflows
- Registry-driven component and code generation pipeline

## Core Features

### 1. AI-Powered Project Ideation

- Start with natural language prompts such as project goals, constraints, and target board.
- Generate structured project concepts that can be refined in follow-up chat iterations.
- Keep design decisions consistent across multiple interactions using project context.

### 2. Board-Aware Hardware Intelligence

- Board context (for example Arduino Uno, Arduino Mega, and Nano style flows) improves pin selection and compatibility.
- Pin capabilities such as PWM, analog, UART, I2C, and SPI are mapped in the component registry.
- AI responses can align wiring and code decisions to realistic board capabilities.

### 3. Component Registry and Smart Mapping

- Central component definitions live in `backend/data/componentRegistry.json`.
- Each component includes:
	- Wokwi part type mapping
	- Pin metadata
	- Signal roles (power, analog, digital, communication buses)
	- Optional attributes/defaults used during generation
- This registry enables deterministic generation instead of free-form, error-prone wiring text.

### 4. Circuit Design Generation

- Generates simulation-ready `diagram.json` wiring layouts.
- Supports iterative design edits by conversation (add/remove parts, revise wiring, update constraints).
- Improves legibility of circuit preview and interaction in the frontend workspace.

### 5. Firmware and Compile Flow

- Generates Arduino sketches (`.ino`) based on selected components and behavior.
- Compile services and related controllers provide a code-validation loop before simulation/runtime testing.
- Helps users identify logical issues early in the prototyping lifecycle.

### 6. Wokwi Simulation Workflow

- Designed to work directly with Wokwi artifacts and local smoke test assets.
- Included smoke projects (`backend/wokwi-smoke*`) support quick regression checks for generated outputs.
- Enables fast verification of pin mapping and runtime behavior in simulation.

### 7. Voice Guidance and Conversational UX

- Voice-related endpoints/services support speech-enabled interaction flows.
- Rich chat rendering in the frontend improves readability for generated plans/code/design responses.
- The UX is built for iterative collaboration rather than one-shot output generation.

### 8. Project and Collaboration Flow

- Project entities persist context for design and firmware sessions.
- Auth and project routes/controllers support multi-session usage patterns.
- Structured separation of ideation, component planning, and design generation improves maintainability.

## How the App Works (End-to-End)

1. User creates or opens a project.
2. User describes the hardware idea in chat.
3. Backend ideation/components services infer required parts and constraints.
4. Design services generate or revise the circuit model.
5. Firmware generation/compile flow creates and validates sketch logic.
6. Wokwi-ready files are produced for simulation and iteration.
7. User refines behavior through additional chat/voice prompts.

## Project Structure

- `backend/` Node.js + Express API and hardware generation services
- `frontend/` React + Vite application
- `backend/data/` component registry, presets, and generated support data
- `backend/wokwi-smoke*` simulation smoke-test assets

### Backend Highlights

- Controllers for auth, ideation, components, design, compile, project, and voice workflows
- Service layer for AI prompting, Arduino CLI integration, registry codegen, and Wokwi integration
- Model layer for users/projects and persistence-backed project workflows
- Route segmentation by domain for easier API maintenance

### Frontend Highlights

- React workspace with dedicated pages for auth, home, design, and project collaboration
- Chat-first UI components for project planning, design revision, and rich response rendering
- Centralized auth/theme stores and API client helpers
- Simulator-focused components for Wokwi proof/testing experiences

## Documentation

- Main architecture and platform overview: this file
- Backend API and service details: `backend/src/`
- Frontend UI and interaction flow: `frontend/src/`
- Component/pin intelligence registry: `backend/data/componentRegistry.json`
- Branch-specific implementation notes: `README_ALDEN_CHANGES.md`

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

Typical categories include:

- LLM provider keys/configuration for ideation/design/code generation
- Voice/STT provider settings (if voice features are enabled)
- Database/auth configuration used by project and user flows
- Optional local simulation/compiler tool settings

## Support

- Open an issue in the repository for bugs, feature requests, or integration questions.
- When reporting bugs, include:
	- Steps to reproduce
	- Expected vs actual behavior
	- Backend/frontend logs
	- Sample prompt or project context (if AI behavior is involved)
	- Environment details (OS, Node version, package manager)

## Notes

- Wokwi and Arduino flows depend on valid local tooling/configuration.
- Voice features depend on configured STT/TTS providers.
- Generated results improve when project prompts include board model, sensor list, and expected behavior.

## License

Project license and usage terms are defined by the repository owner.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Keep changes scoped and add/update relevant docs.
4. Run backend and frontend locally to verify behavior.
5. Open a pull request with clear description and screenshots/logs when applicable.
