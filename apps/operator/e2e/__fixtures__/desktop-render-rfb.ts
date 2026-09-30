/** Deterministic local framebuffer for actual HostedDesktopViewer chrome.
 * No remote server or input transport is exercised by this fixture.
 */
export default class FixtureRfb {
  viewOnly = true; scaleViewport = true; clipViewport = true;
  resizeSession = false; focusOnClick = false; background = '';
  readonly canvas: HTMLCanvasElement;
  constructor(element: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280; this.canvas.height = 720;
    this.canvas.style.cssText = 'display:block;width:100%;height:auto;max-height:100%;object-fit:contain';
    this.canvas.dataset.readyFixture = 'true';
    this.canvas.setAttribute('aria-label', 'Controlled local framebuffer; no live connection');
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#284b42'; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#182c28'; ctx.fillRect(0, 0, 1280, 38);
    ctx.fillStyle = '#ffffff'; ctx.font = '18px sans-serif';
    ctx.fillText('Applications     Places     Desktop', 18, 26);
    ctx.fillStyle = '#eef1df'; ctx.fillRect(90, 100, 1100, 520);
    ctx.fillStyle = '#d8ddce'; ctx.fillRect(90, 100, 1100, 40);
    ctx.fillStyle = '#153d32'; ctx.font = '22px sans-serif';
    ctx.fillText('Local acceptance fixture', 112, 128);
    ctx.font = '42px sans-serif'; ctx.fillText('Desktop state coverage', 140, 245);
    ctx.font = '24px sans-serif'; ctx.fillText('Controlled framebuffer for layout and viewer controls.', 140, 300);
    ctx.fillText('No cloud service, remote video or input connection.', 140, 342);
    ctx.fillStyle = '#b5c7a3'; ctx.fillRect(140, 395, 460, 140);
    ctx.fillStyle = '#c8d4bc'; ctx.fillRect(640, 395, 470, 140);
    element.append(this.canvas);
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'connect') queueMicrotask(listener);
  }
  disconnect() { this.canvas.remove(); }
}
