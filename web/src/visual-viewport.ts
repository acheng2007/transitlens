/** Keep modal controls inside the visible area when Safari opens its keyboard. */
export function trackVisualViewport(target: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;
  function update() {
    target.style.setProperty('--visible-height', `${viewport?.height ?? window.innerHeight}px`);
    target.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
  }
  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
  };
}
