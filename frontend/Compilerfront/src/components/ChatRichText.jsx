const splitBoldSegments = (text = "") => {
  const source = String(text);
  const regex = /\*\*(.+?)\*\*/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: source.slice(lastIndex, match.index), bold: false });
    }

    parts.push({ text: match[1], bold: true });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < source.length) {
    parts.push({ text: source.slice(lastIndex), bold: false });
  }

  return parts;
};

const renderLine = (line, index, isDark) => {
  const trimmed = line.trim();

  if (!trimmed) {
    return <div key={`spacer-${index}`} className="h-2" />;
  }

  const isBullet = /^[-*]\s+/.test(trimmed);
  const isNumbered = /^\d+[.)]\s+/.test(trimmed);
  const cleanText = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
  const segments = splitBoldSegments(cleanText);

  const content = (
    <>
      {segments.map((segment, segmentIndex) => (
        <span
          key={`segment-${index}-${segmentIndex}`}
          className={segment.bold ? `rounded px-1 ${isDark ? "bg-white/10 text-white" : "bg-black/8 text-black"}` : ""}
        >
          {segment.text}
        </span>
      ))}
    </>
  );

  if (isBullet) {
    return (
      <div key={`bullet-${index}`} className="flex items-start gap-2">
        <span className={`mt-[7px] h-1.5 w-1.5 rounded-full ${isDark ? "bg-[#9f9f9f]" : "bg-[#666]"}`} />
        <div className="flex-1">{content}</div>
      </div>
    );
  }

  if (isNumbered) {
    return (
      <div key={`number-${index}`} className={`font-medium ${isDark ? "text-[#f1f1f1]" : "text-[#111]"}`}>
        {content}
      </div>
    );
  }

  return (
    <div key={`line-${index}`}>
      {content}
    </div>
  );
};

export default function ChatRichText({ text = "", isDark = true }) {
  const lines = String(text).split("\n");

  return (
    <div className="space-y-1 text-sm leading-relaxed whitespace-pre-wrap">
      {lines.map((line, index) => renderLine(line, index, isDark))}
    </div>
  );
}
