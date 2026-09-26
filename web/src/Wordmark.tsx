// Marca: cuatro pétalos que son también cuatro notas enlazadas por el centro.
export function Glyph({ className = 'wordmark-glyph' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
      <path d="M15 15H6.5A5.5 5.5 0 0 1 1 9.5V6.5A5.5 5.5 0 0 1 6.5 1h3A5.5 5.5 0 0 1 15 6.5Z" />
      <path d="M17 15h8.5A5.5 5.5 0 0 0 31 9.5V6.5A5.5 5.5 0 0 0 25.5 1h-3A5.5 5.5 0 0 0 17 6.5Z" />
      <path d="M15 17H6.5A5.5 5.5 0 0 0 1 22.5v3A5.5 5.5 0 0 0 6.5 31h3a5.5 5.5 0 0 0 5.5-5.5Z" />
      <path d="M17 17h8.5a5.5 5.5 0 0 1 5.5 5.5v3a5.5 5.5 0 0 1-5.5 5.5h-3a5.5 5.5 0 0 1-5.5-5.5Z" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`} aria-label="Canvian">
      <Glyph />
      <span className="wordmark-text" aria-hidden="true">
        <span className="c">C</span>
        <span className="rest">ANVIAN</span>
      </span>
    </span>
  );
}
