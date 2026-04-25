import { useEffect, useMemo, useRef, useState } from 'react';
import { CPU, avrInstruction } from 'avr8js';
import { useThemeStore } from '../store/useThemeStore';
import toast from 'react-hot-toast';

const PART_W = 120;
const PART_H = 90;

const parseEndpoint = (endpoint = '') => {
  const [partId, pin = ''] = String(endpoint).split(':');
  return { partId, pin };
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const normalizePin = (pin = '') => String(pin || '').trim().toUpperCase();

const readCpuByte = (cpu, address) => {
  if (!cpu) return 0;
  if (cpu.data instanceof Uint8Array && address >= 0 && address < cpu.data.length) {
    return cpu.data[address] ?? 0;
  }
  if (cpu.dataView instanceof DataView) {
    try {
      return cpu.dataView.getUint8(address);
    } catch {
      return 0;
    }
  }
  return 0;
};

const segmentStyle = (on, color) => ({
  fill: on ? color : '#2d2d2d',
  stroke: on ? '#ffb27a' : '#444',
  strokeWidth: 1.5,
  opacity: on ? 1 : 0.5,
});

const getPartColor = (type) => {
  if (type.includes('led')) return '#ef4444';
  if (type.includes('7segment')) return '#f97316';
  if (type.includes('servo')) return '#60a5fa';
  if (type.includes('button')) return '#94a3b8';
  if (type.includes('mega')) return '#3b82f6';
  if (type.includes('arduino') || type.includes('uno')) return '#22c55e';
  return '#64748b';
};

const isArduinoMega = (type = '') => {
  const lower = String(type).toLowerCase();
  return lower.includes('mega') || lower.includes('wokwi-arduino-mega');
};

const isArduinoUno = (type = '') => {
  const lower = String(type).toLowerCase();
  return lower.includes('uno') || lower.includes('wokwi-arduino-uno');
};

export default function WokwiSimulator({
  hexCode,
  diagramJson,
  sketchCode,
}) {
  const { theme } = useThemeStore();
  const isDark = theme === 'dark';

  const simulatorRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [running, setRunning] = useState(false);
  const [serialOutput, setSerialOutput] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [cycleCount, setCycleCount] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [partStates, setPartStates] = useState({});
  const [partPositions, setPartPositions] = useState({});
  const cycleCountRef = useRef(0);
  const dragRef = useRef({
    activeId: null,
    offsetX: 0,
    offsetY: 0,
    pointerId: null,
  });
  const boardRef = useRef(null);

  const parts = diagramJson?.parts || [];
  const connections = diagramJson?.connections || [];

  const positionedParts = useMemo(() => {
    if (!parts.length) return [];
    return parts.map((part, index) => ({
      ...part,
      x: Number.isFinite(partPositions[part.id]?.x)
        ? partPositions[part.id].x
        : Number.isFinite(part.x)
          ? part.x
          : 40 + (index % 5) * 160,
      y: Number.isFinite(partPositions[part.id]?.y)
        ? partPositions[part.id].y
        : Number.isFinite(part.y)
          ? part.y
          : 40 + Math.floor(index / 5) * 130,
      w: PART_W,
      h: PART_H,
    }));
  }, [parts, partPositions]);

  const partById = useMemo(() => {
    const map = new Map();
    positionedParts.forEach((part) => map.set(part.id, part));
    return map;
  }, [positionedParts]);

  const canvasSize = useMemo(() => {
    const maxX = positionedParts.reduce((m, p) => Math.max(m, p.x + p.w), 600);
    const maxY = positionedParts.reduce((m, p) => Math.max(m, p.y + p.h), 400);
    return { width: maxX + 100, height: maxY + 100 };
  }, [positionedParts]);

  useEffect(() => {
    if (!parts.length) return;

    setPartPositions((current) => {
      const next = { ...current };
      let changed = false;

      parts.forEach((part, index) => {
        if (next[part.id]) return;
        next[part.id] = {
          x: Number.isFinite(part.x) ? part.x : 40 + (index % 5) * 160,
          y: Number.isFinite(part.y) ? part.y : 40 + Math.floor(index / 5) * 130,
        };
        changed = true;
      });

      return changed ? next : current;
    });
  }, [parts]);

  const parseHexFile = (hexData) => {
    try {
      const lines = String(hexData || '').split('\n').filter((line) => line.trim());
      const bytes = [];

      for (const line of lines) {
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.substring(1, 3), 16);
        const address = parseInt(line.substring(3, 7), 16);
        const recordType = parseInt(line.substring(7, 9), 16);

        if (recordType === 0x00) {
          for (let i = 0; i < byteCount; i++) {
            const byte = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
            bytes[address + i] = byte;
          }
        } else if (recordType === 0x01) {
          break;
        }
      }

      if (!bytes.length) return null;

      const result = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        result[i] = bytes[i] !== undefined ? bytes[i] : 0xff;
      }
      return result;
    } catch {
      return null;
    }
  };

  const getPortState = (cpu) => {
    const portD = readCpuByte(cpu, 0x2b);
    const portB = readCpuByte(cpu, 0x25);
    return { portD, portB };
  };

  const updateVisualStates = (cpu) => {
    const { portD, portB } = getPortState(cpu);

    const next = {};
    positionedParts.forEach((part, index) => {
      const bit = index % 8;
      const ledOn = ((portD >> bit) & 1) === 1;
      const servoRaw = portB & 0b00011111;
      const servoAngle = Math.round((servoRaw / 31) * 180);
      const sevenSeg = Array.from({ length: 8 }, (_, i) => ((portD >> i) & 1) === 1 ? 1 : 0);

      next[part.id] = {
        lit: ledOn,
        angle: servoAngle,
        seg: sevenSeg,
        clock: ((cycleCountRef.current / 5000) % 10).toFixed(0),
      };
    });

    setPartStates(next);
  };

  useEffect(() => {
    if (!hexCode || !diagramJson) {
      setErrorMessage('Missing hex code or diagram');
      return;
    }

    const program = parseHexFile(hexCode);
    if (!program) {
      setErrorMessage('Invalid hex file format');
      setStatus('error');
      return;
    }

    try {
      const cpu = new CPU(program);
      simulatorRef.current = { cpu };
      setStatus('ready');
      setErrorMessage('');
      updateVisualStates(cpu);
    } catch (err) {
      setErrorMessage(`Init error: ${err.message}`);
      setStatus('error');
    }
  }, [hexCode, diagramJson, positionedParts.length]);

  useEffect(() => {
    if (!running || !simulatorRef.current?.cpu) return;

    const startedAt = Date.now();
    const interval = setInterval(() => {
      try {
        const cpu = simulatorRef.current.cpu;
        for (let i = 0; i < 8000; i++) {
          avrInstruction(cpu);
        }

        const nextCycles = cycleCountRef.current + 8000;
        cycleCountRef.current = nextCycles;
        setCycleCount(nextCycles);
        setElapsedTime((Date.now() - startedAt) / 1000);
        updateVisualStates(cpu);

        // Lightweight synthetic serial for visibility in prototype mode.
        if (nextCycles % 64000 === 0) {
          setSerialOutput((prev) => {
            const line = `tick=${nextCycles} portD=${readCpuByte(cpu, 0x2b).toString(16)}\n`;
            const combined = `${prev}${line}`;
            return combined.split('\n').slice(-25).join('\n');
          });
        }
      } catch (err) {
        setErrorMessage(`Runtime error: ${err.message}`);
        setRunning(false);
        setStatus('error');
      }
    }, 16);

    return () => clearInterval(interval);
  }, [running]);

  const handlePlayPause = () => {
    if (status === 'error') {
      toast.error('Cannot run simulator in error state');
      return;
    }
    setRunning((prev) => {
      const next = !prev;
      setStatus(next ? 'running' : 'paused');
      return next;
    });
  };

  const handleReset = () => {
    setRunning(false);
    cycleCountRef.current = 0;
    setCycleCount(0);
    setElapsedTime(0);
    setSerialOutput('');

    const program = parseHexFile(hexCode);
    if (!program) {
      setErrorMessage('Invalid hex file format');
      setStatus('error');
      return;
    }

    try {
      const cpu = new CPU(program);
      simulatorRef.current = { cpu };
      updateVisualStates(cpu);
      setStatus('ready');
      setErrorMessage('');
    } catch (err) {
      setErrorMessage(`Reset error: ${err.message}`);
      setStatus('error');
    }
  };

  const stopDragging = () => {
    dragRef.current.activeId = null;
    dragRef.current.pointerId = null;
    if (boardRef.current) {
      boardRef.current.style.cursor = 'default';
    }
  };

  const handlePartPointerDown = (event, part) => {
    event.preventDefault();
    event.stopPropagation();

    const board = boardRef.current;
    if (!board) return;

    const bounds = board.getBoundingClientRect();
    const current = partPositions[part.id] || { x: part.x, y: part.y };
    const scaleX = canvasSize.width / bounds.width;
    const scaleY = canvasSize.height / bounds.height;
    const pointerX = (event.clientX - bounds.left) * scaleX;
    const pointerY = (event.clientY - bounds.top) * scaleY;

    dragRef.current = {
      activeId: part.id,
      offsetX: pointerX - current.x,
      offsetY: pointerY - current.y,
      pointerId: event.pointerId,
    };

    board.style.cursor = 'grabbing';
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleBoardPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag.activeId || !boardRef.current) return;

    const bounds = boardRef.current.getBoundingClientRect();
    const scaleX = canvasSize.width / bounds.width;
    const scaleY = canvasSize.height / bounds.height;
    const pointerX = (event.clientX - bounds.left) * scaleX;
    const pointerY = (event.clientY - bounds.top) * scaleY;
    const nextX = Math.max(10, pointerX - drag.offsetX);
    const nextY = Math.max(10, pointerY - drag.offsetY);

    setPartPositions((current) => ({
      ...current,
      [drag.activeId]: { x: nextX, y: nextY },
    }));
  };

  const handleBoardPointerUp = () => {
    stopDragging();
  };

  const getPinAnchor = (part, pin) => {
    const p = normalizePin(pin);
    const type = String(part.type || '').toLowerCase();
    const left = part.x - 6;
    const right = part.x + part.w + 6;
    const top = part.y - 6;
    const bottom = part.y + part.h + 6;

    const anchor = (x, y, side = 'auto') => ({ x, y, side });

    if (type.includes('arduino') || type.includes('uno') || type.includes('mega')) {
      if (/^D([0-9]|1[0-3])$/.test(p)) {
        const n = Number(p.slice(1));
        const ratio = clamp01((n + 0.5) / 14);
        return anchor(part.x + part.w * ratio, bottom, 'bottom');
      }
      if (/^A([0-5])$/.test(p)) {
        const n = Number(p.slice(1));
        const ratio = clamp01((n + 0.5) / 6);
        return anchor(part.x + part.w * ratio, top, 'top');
      }
      if (["GND", "5V", "3V3", "3.3V", "VIN", "RST", "AREF"].includes(p)) {
        const map = {
          GND: 0.12,
          "5V": 0.25,
          "3V3": 0.35,
          "3.3V": 0.35,
          VIN: 0.88,
          RST: 0.75,
          AREF: 0.62,
        };
        return anchor(part.x + part.w * (map[p] ?? 0.5), top, 'top');
      }
      return anchor(part.x + part.w * 0.5, bottom, 'bottom');
    }

    if (type.includes('7segment')) {
      const pinMap = {
        A: anchor(part.x + part.w * 0.2, top, 'top'),
        B: anchor(right, part.y + part.h * 0.22, 'right'),
        C: anchor(right, part.y + part.h * 0.48, 'right'),
        D: anchor(part.x + part.w * 0.2, bottom, 'bottom'),
        E: anchor(left, part.y + part.h * 0.68, 'left'),
        F: anchor(left, part.y + part.h * 0.36, 'left'),
        G: anchor(part.x + part.w * 0.48, part.y + part.h * 0.5, 'bottom'),
        DP: anchor(right, part.y + part.h * 0.84, 'right'),
        COM: anchor(part.x + part.w * 0.5, bottom, 'bottom'),
      };
      return pinMap[p] || anchor(part.x + part.w * 0.5, bottom, 'bottom');
    }

    if (type.includes('led')) {
      if (p === 'A' || p === 'ANODE') return anchor(part.x + part.w * 0.45, bottom, 'bottom');
      if (p === 'C' || p === 'K' || p === 'CATHODE') return anchor(part.x + part.w * 0.62, bottom, 'bottom');
      return anchor(part.x + part.w * 0.54, bottom, 'bottom');
    }

    if (type.includes('servo')) {
      const pinMap = {
        SIGNAL: anchor(left, part.y + part.h * 0.25, 'left'),
        VCC: anchor(left, part.y + part.h * 0.5, 'left'),
        GND: anchor(left, part.y + part.h * 0.75, 'left'),
      };
      return pinMap[p] || anchor(left, part.y + part.h * 0.5, 'left');
    }

    if (type.includes('pushbutton') || type.includes('button')) {
      const pinMap = {
        "1": anchor(left, part.y + part.h * 0.3, 'left'),
        "2": anchor(right, part.y + part.h * 0.3, 'right'),
        "3": anchor(left, part.y + part.h * 0.7, 'left'),
        "4": anchor(right, part.y + part.h * 0.7, 'right'),
      };
      return pinMap[p] || anchor(part.x + part.w * 0.5, bottom, 'bottom');
    }

    if (type.includes('hcsr04')) {
      const pinMap = {
        VCC: anchor(part.x + part.w * 0.2, top, 'top'),
        TRIG: anchor(part.x + part.w * 0.4, top, 'top'),
        ECHO: anchor(part.x + part.w * 0.6, top, 'top'),
        GND: anchor(part.x + part.w * 0.8, top, 'top'),
      };
      return pinMap[p] || anchor(part.x + part.w * 0.5, top, 'top');
    }

    if (p.startsWith('GND') || p.startsWith('VCC')) {
      return anchor(part.x + part.w * 0.5, bottom, 'bottom');
    }
    if (p.startsWith('A') || p.startsWith('D') || p.startsWith('Q')) {
      return anchor(right, part.y + part.h * 0.45, 'right');
    }
    return anchor(left, part.y + part.h * 0.45, 'left');
  };

  const buildWirePath = (from, to) => {
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;

    if (from.side === 'left' && to.side === 'right') {
      return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
    }

    if (from.side === 'right' && to.side === 'left') {
      return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
    }

    if (from.side === 'top' && to.side === 'bottom') {
      return `M ${from.x} ${from.y} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y}`;
    }

    if (from.side === 'bottom' && to.side === 'top') {
      return `M ${from.x} ${from.y} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y}`;
    }

    return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
  };

  const renderPart = (part) => {
    const state = partStates[part.id] || {};
    const color = getPartColor(part.type);
    const dragAttrs = {
      onPointerDown: (event) => handlePartPointerDown(event, part),
    };

    if (part.type.includes('7segment')) {
      const seg = state.seg || Array(8).fill(0);
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="3" y="4" width={part.w - 6} height={part.h - 8} rx="12" fill="#101827" stroke="#4b5563" strokeWidth="2" />
          <rect x="10" y="10" width={part.w - 20} height={part.h - 28} rx="10" fill="#070b13" stroke="#20293a" strokeWidth="1.5" />
          <text x={part.w / 2} y="22" textAnchor="middle" fontSize="10" fontWeight="700" fill="#d1d5db">7-SEG</text>
          <polygon points="26,18 58,18 52,26 32,26" style={segmentStyle(seg[0], '#fb923c')} />
          <polygon points="60,28 68,32 68,46 60,50 54,44 54,34" style={segmentStyle(seg[1], '#fb923c')} />
          <polygon points="60,54 68,58 68,72 60,76 54,70 54,60" style={segmentStyle(seg[2], '#fb923c')} />
          <polygon points="26,78 58,78 52,86 32,86" style={segmentStyle(seg[3], '#fb923c')} />
          <polygon points="16,54 24,60 24,72 18,78 12,74 12,58" style={segmentStyle(seg[4], '#fb923c')} />
          <polygon points="16,28 24,34 24,46 18,52 12,48 12,32" style={segmentStyle(seg[5], '#fb923c')} />
          <polygon points="26,46 58,46 52,54 32,54" style={segmentStyle(seg[6], '#fb923c')} />
          <circle cx="74" cy="76" r="4" fill={seg[7] ? '#fb923c' : '#2d2d2d'} />
          <line x1="6" y1="14" x2="6" y2="70" stroke="#6b7280" strokeWidth="1.5" strokeDasharray="3 3" />
          <line x1="94" y1="14" x2="94" y2="70" stroke="#6b7280" strokeWidth="1.5" strokeDasharray="3 3" />
          <text x={part.w / 2} y="92" textAnchor="middle" fontSize="9" fill="#9ca3af">{part.id}</text>
        </g>
      );
    }

    if (part.type.includes('led')) {
      const lit = !!state.lit;
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="14" y="18" width="76" height="50" rx="18" fill="#111827" stroke="#374151" strokeWidth="2" />
          <ellipse cx="52" cy="40" rx="20" ry="24" fill={lit ? '#fecaca' : '#7f1d1d'} stroke="#b91c1c" strokeWidth="2" />
          <circle cx="52" cy="36" r="9" fill={lit ? '#fff1f2' : '#450a0a'} opacity="0.75" />
          {lit && <circle cx="52" cy="40" r="34" fill="#ef4444" opacity="0.18" />}
          <line x1="44" y1="68" x2="44" y2="88" stroke="#d1d5db" strokeWidth="3" />
          <line x1="60" y1="68" x2="60" y2="88" stroke="#9ca3af" strokeWidth="3" />
          <text x="52" y="102" textAnchor="middle" fontSize="9" fill="#9ca3af">{part.id}</text>
        </g>
      );
    }

    if (part.type.includes('servo')) {
      const angle = Number.isFinite(state.angle) ? state.angle : 90;
      const rad = ((angle - 90) * Math.PI) / 180;
      const x2 = 56 + Math.cos(rad) * 28;
      const y2 = 40 + Math.sin(rad) * 28;
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="10" y="16" width="92" height="56" rx="10" fill="#1d4ed8" stroke="#93c5fd" strokeWidth="2" />
          <rect x="20" y="22" width="72" height="14" rx="6" fill="#2563eb" opacity="0.5" />
          <circle cx="56" cy="44" r="12" fill="#dbeafe" stroke="#60a5fa" strokeWidth="2" />
          <line x1="56" y1="44" x2={x2} y2={y2} stroke="#f8fafc" strokeWidth="5" strokeLinecap="round" />
          <circle cx={x2} cy={y2} r="4" fill="#f8fafc" />
          <text x="56" y="84" textAnchor="middle" fontSize="9" fill="#dbeafe">{part.id} · {angle}°</text>
        </g>
      );
    }

    if (part.type.includes('pushbutton') || part.type.includes('button')) {
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="16" y="18" width="76" height="52" rx="10" fill="#111827" stroke="#6b7280" strokeWidth="2" />
          <rect x="24" y="26" width="60" height="36" rx="8" fill="#374151" stroke="#9ca3af" strokeWidth="1.5" />
          <circle cx="54" cy="44" r="14" fill="#e5e7eb" stroke="#6b7280" strokeWidth="2" />
          <circle cx="54" cy="44" r="6" fill="#9ca3af" />
          <line x1="40" y1="16" x2="40" y2="10" stroke="#9ca3af" strokeWidth="2" />
          <line x1="68" y1="16" x2="68" y2="10" stroke="#9ca3af" strokeWidth="2" />
          <text x="54" y="88" textAnchor="middle" fontSize="9" fill="#9ca3af">{part.id}</text>
        </g>
      );
    }

    if (part.type.includes('hcsr04')) {
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="8" y="14" width="102" height="58" rx="10" fill="#1f2937" stroke="#334155" strokeWidth="2" />
          <rect x="18" y="22" width="82" height="42" rx="8" fill="#111827" stroke="#475569" strokeWidth="1.5" />
          <circle cx="36" cy="43" r="16" fill="#0f172a" stroke="#94a3b8" strokeWidth="3" />
          <circle cx="78" cy="43" r="16" fill="#0f172a" stroke="#94a3b8" strokeWidth="3" />
          <circle cx="36" cy="43" r="6" fill="#64748b" />
          <circle cx="78" cy="43" r="6" fill="#64748b" />
          <rect x="44" y="56" width="24" height="6" rx="3" fill="#64748b" />
          <text x="59" y="88" textAnchor="middle" fontSize="9" fill="#9ca3af">{part.id}</text>
        </g>
      );
    }

    if (isArduinoMega(part.type)) {
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="2" y="4" width="140" height="84" rx="12" fill="#2f6fb4" stroke="#8ec8ff" strokeWidth="2.5" />
          <rect x="8" y="8" width="126" height="72" rx="10" fill="none" stroke="#7db7ee" strokeWidth="1.2" strokeDasharray="5 4" opacity="0.85" />
          <rect x="12" y="14" width="30" height="20" rx="3" fill="#587ea8" stroke="#dbeafe" strokeWidth="1" />
          <rect x="48" y="14" width="24" height="18" rx="2" fill="#0f766e" stroke="#99f6e4" strokeWidth="1" />
          <rect x="78" y="14" width="38" height="16" rx="2" fill="#1f2937" stroke="#d1d5db" strokeWidth="1" />
          <rect x="18" y="38" width="44" height="22" rx="4" fill="#1b4d78" stroke="#bfdbfe" strokeWidth="1" />
          <rect x="70" y="38" width="26" height="24" rx="4" fill="#111827" stroke="#94a3b8" strokeWidth="1" />
          <rect x="102" y="36" width="18" height="26" rx="3" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1" />
          <circle cx="20" cy="76" r="2" fill="#dbeafe" />
          <circle cx="30" cy="76" r="2" fill="#dbeafe" />
          <circle cx="40" cy="76" r="2" fill="#dbeafe" />
          <circle cx="50" cy="76" r="2" fill="#dbeafe" />
          <circle cx="60" cy="76" r="2" fill="#dbeafe" />
          <circle cx="70" cy="76" r="2" fill="#dbeafe" />
          <circle cx="80" cy="76" r="2" fill="#dbeafe" />
          <circle cx="90" cy="76" r="2" fill="#dbeafe" />
          <circle cx="100" cy="76" r="2" fill="#dbeafe" />
          <circle cx="110" cy="76" r="2" fill="#dbeafe" />
          <circle cx="120" cy="76" r="2" fill="#dbeafe" />
          <circle cx="130" cy="76" r="2" fill="#dbeafe" />
          <text x="72" y="52" textAnchor="middle" fontSize="10" fontWeight="700" fill="#eff6ff">Arduino MEGA</text>
          <text x="72" y="96" textAnchor="middle" fontSize="9" fill="#cbd5e1">{part.id}</text>
        </g>
      );
    }

    if (isArduinoUno(part.type)) {
      return (
        <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
          <rect x="2" y="4" width="116" height="82" rx="12" fill="#14532d" stroke="#34d399" strokeWidth="2.5" />
          <rect x="6" y="8" width="108" height="74" rx="10" fill="none" stroke="#0f7c44" strokeWidth="1.2" strokeDasharray="5 4" opacity="0.8" />
          <rect x="12" y="14" width="26" height="20" rx="3" fill="#166534" stroke="#bbf7d0" strokeWidth="1" />
          <rect x="44" y="14" width="26" height="18" rx="2" fill="#0f766e" stroke="#99f6e4" strokeWidth="1" />
          <rect x="74" y="14" width="26" height="16" rx="2" fill="#334155" stroke="#cbd5e1" strokeWidth="1" />
          <rect x="18" y="40" width="36" height="22" rx="4" fill="#0b3b2a" stroke="#34d399" strokeWidth="1" />
          <rect x="60" y="38" width="24" height="26" rx="4" fill="#1f2937" stroke="#94a3b8" strokeWidth="1" />
          <rect x="88" y="38" width="18" height="26" rx="3" fill="#111827" stroke="#94a3b8" strokeWidth="1" />
          <circle cx="20" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="30" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="40" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="50" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="60" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="70" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="80" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="90" cy="72" r="2.1" fill="#d1d5db" />
          <circle cx="100" cy="72" r="2.1" fill="#d1d5db" />
          <text x="60" y="52" textAnchor="middle" fontSize="10" fontWeight="700" fill="#dcfce7">ARDUINO UNO</text>
          <text x="60" y="96" textAnchor="middle" fontSize="9" fill="#9ca3af">{part.id}</text>
        </g>
      );
    }

    return (
      <g key={part.id} transform={`translate(${part.x}, ${part.y})`} {...dragAttrs}>
        <path d="M16 12 L88 12 L104 45 L88 78 L16 78 L0 45 Z" fill={color} opacity="0.22" stroke={color} strokeWidth="2" />
        <circle cx="16" cy="12" r="3" fill="#e2e8f0" opacity="0.7" />
        <circle cx="88" cy="12" r="3" fill="#e2e8f0" opacity="0.7" />
        <circle cx="104" cy="45" r="3" fill="#e2e8f0" opacity="0.7" />
        <circle cx="88" cy="78" r="3" fill="#e2e8f0" opacity="0.7" />
        <circle cx="16" cy="78" r="3" fill="#e2e8f0" opacity="0.7" />
        <circle cx="0" cy="45" r="3" fill="#e2e8f0" opacity="0.7" />
        <text x="52" y="42" textAnchor="middle" fontSize="9" fill="#e2e8f0">{part.type}</text>
        <text x="52" y="57" textAnchor="middle" fontSize="9" fill="#cbd5e1">{part.id}</text>
      </g>
    );
  };

  return (
    <div className={`flex h-full flex-col overflow-hidden ${isDark ? 'bg-[#151515] text-[#e5e5e5]' : 'bg-[#fafafa] text-[#111]'}`}>
      <div className={`border-b px-4 py-3 ${isDark ? 'border-white/10 bg-gradient-to-r from-[#151515] to-[#1d1d1d]' : 'border-black/10 bg-gradient-to-r from-white to-[#f3f4f6]'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`text-xs font-semibold uppercase tracking-[0.22em] ${isDark ? 'text-[#a3a3a3]' : 'text-[#666]'}`}>
              Custom Hardware Visualizer
            </p>
            <p className={`mt-1 text-xs ${isDark ? 'text-[#a3a3a3]' : 'text-[#666]'}`}>
              Status: <span className={`font-semibold ${status === 'running' ? 'text-emerald-400' : status === 'error' ? 'text-red-400' : 'text-amber-400'}`}>{status.toUpperCase()}</span>
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handlePlayPause}
              disabled={status === 'error'}
              className={`rounded border px-3 py-1 text-xs font-semibold transition ${isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'} ${status === 'error' ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {running ? 'Pause' : 'Play'}
            </button>

            <button
              onClick={handleReset}
              className={`rounded border px-3 py-1 text-xs font-semibold transition ${isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`}
            >
              Reset
            </button>

            <button
              onClick={() => setSerialOutput('')}
              className={`rounded border px-3 py-1 text-xs font-semibold transition ${isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`}
            >
              Clear
            </button>

            <span className={`text-xs font-mono ${isDark ? 'text-[#a3a3a3]' : 'text-[#666]'}`}>
              {cycleCount.toLocaleString()} cycles
            </span>
          </div>
        </div>
      </div>

      {errorMessage && (
        <div className={`border-b px-4 py-2 ${isDark ? 'border-red-500/30 bg-red-500/10' : 'border-red-400 bg-red-50'}`}>
          <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-700'}`}>
            {errorMessage}
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3">
        <div
          ref={boardRef}
          onPointerMove={handleBoardPointerMove}
          onPointerUp={handleBoardPointerUp}
          onPointerLeave={handleBoardPointerUp}
          className={`flex-1 min-w-0 rounded-2xl border overflow-auto shadow-lg ${isDark ? 'border-white/10 bg-[#0f172a]' : 'border-black/10 bg-white'}`}
        >
          {positionedParts.length ? (
            <svg
              width={canvasSize.width}
              height={canvasSize.height}
              viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
              className="block"
            >
              <defs>
                <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="6" stdDeviation="6" floodColor="#000000" floodOpacity="0.18" />
                </filter>
                <linearGradient id="boardBg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor={isDark ? '#0b1220' : '#ffffff'} />
                  <stop offset="100%" stopColor={isDark ? '#111827' : '#eef2ff'} />
                </linearGradient>
              </defs>
              <rect x="0" y="0" width={canvasSize.width} height={canvasSize.height} fill="url(#boardBg)" />
              <defs>
                <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke={isDark ? '#1e293b' : '#dbeafe'} strokeWidth="1" />
                </pattern>
              </defs>
              <rect x="0" y="0" width={canvasSize.width} height={canvasSize.height} fill="url(#grid)" opacity="0.8" />

              <g opacity="0.55">
                <rect x="22" y="18" width="120" height="28" rx="10" fill={isDark ? '#172554' : '#dbeafe'} />
                <text x="42" y="37" fontSize="12" fontWeight="700" fill={isDark ? '#bfdbfe' : '#1d4ed8'}>Hardware View</text>
              </g>

              {connections.map((connection, idx) => {
                const [fromRaw, toRaw, color = '#10b981'] = connection;
                const from = parseEndpoint(fromRaw);
                const to = parseEndpoint(toRaw);
                const fromPart = partById.get(from.partId);
                const toPart = partById.get(to.partId);
                if (!fromPart || !toPart) return null;

                const a = getPinAnchor(fromPart, from.pin);
                const b = getPinAnchor(toPart, to.pin);
                const path = buildWirePath(a, b);
                const labelX = (a.x + b.x) / 2;
                const labelY = Math.min(a.y, b.y) - 8;

                return (
                  <g key={`wire-${idx}`}>
                    <path
                      d={path}
                      stroke={color}
                      strokeWidth="2.5"
                      fill="none"
                      opacity="0.95"
                      filter="url(#softShadow)"
                    />
                    <circle cx={a.x} cy={a.y} r="2" fill={color} />
                    <circle cx={b.x} cy={b.y} r="2" fill={color} />
                    <rect x={labelX - 24} y={labelY - 10} width="48" height="14" rx="5" fill={isDark ? '#0f172a' : '#ffffff'} opacity="0.55" stroke={color} strokeWidth="0.8" />
                    <text x={labelX} y={labelY} textAnchor="middle" fontSize="7" fontWeight="600" fill={color} opacity="0.8">
                      {from.partId}:{from.pin} → {to.partId}:{to.pin}
                    </text>
                  </g>
                );
              })}

              {positionedParts.map(renderPart)}
            </svg>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className={`text-sm ${isDark ? 'text-[#a3a3a3]' : 'text-[#666]'}`}>No circuit diagram loaded</p>
            </div>
          )}
        </div>

        <div className={`w-72 min-w-0 rounded-2xl border ${isDark ? 'border-white/10 bg-[#0a0a0a]' : 'border-black/10 bg-white'} flex flex-col shadow-lg`}>
          <div className={`border-b px-3 py-2 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
            <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${isDark ? 'text-[#a3a3a3]' : 'text-[#666]'}`}>
              Serial Output
            </p>
          </div>
          <div
            className={`flex-1 min-h-0 overflow-y-auto font-mono text-xs p-3 ${isDark ? 'text-green-300' : 'text-[#333]'}`}
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {serialOutput || (isDark ? '$ waiting...' : '# waiting...')}
          </div>
        </div>
      </div>

      <div className={`border-t px-4 py-2 text-xs ${isDark ? 'border-white/10 text-[#a3a3a3]' : 'border-black/10 text-[#666]'}`}>
        <p>
          {`Elapsed: ${elapsedTime.toFixed(2)}s • `}
          {sketchCode ? `Sketch: ${sketchCode.split('\n')[0].substring(0, 40)}...` : 'No sketch loaded'}
        </p>
      </div>
    </div>
  );
}
