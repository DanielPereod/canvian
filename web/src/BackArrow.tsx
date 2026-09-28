// La flecha de «volver»: dibujada, para que quede centrada con el texto en
// cualquier letra (el carácter ← cae más bajo en unas fuentes que en otras).
export function BackArrow() {
  return (
    <svg className="back-arrow" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M11 6H1.5M5.5 2 1.5 6l4 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
