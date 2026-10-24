type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
  unlock?: () => void;
};

/** Native landscape when available, with a CSS landscape layout as a fallback. */
export class PhoneScreen {
  private active = false;
  private disposed = false;
  private revision = 0;
  private fullscreenOwned = false;
  private orientationOwned = false;
  private pendingEntry?: Promise<void>;
  private readonly orientation = window.screen.orientation as LockableOrientation | undefined;
  private readonly viewport = window.visualViewport;

  constructor(private readonly onLayoutChange: () => void) {
    window.addEventListener('resize', this.refresh);
    window.addEventListener('orientationchange', this.refresh);
    this.viewport?.addEventListener('resize', this.refresh);
    this.orientation?.addEventListener('change', this.refresh);
    document.addEventListener('fullscreenchange', this.fullscreenChanged);
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    if (this.active !== active) {
      this.active = active;
      this.revision++;
      if (!active) this.releaseNativeLayout();
    }
    this.refresh();
  }

  async enterLandscape(): Promise<void> {
    if (!this.active || this.disposed) return;
    if (this.pendingEntry) return this.pendingEntry;
    const operation = this.enterNativeLayout(this.revision);
    this.pendingEntry = operation;
    try {
      await operation;
    } finally {
      if (this.pendingEntry === operation) this.pendingEntry = undefined;
      this.refresh();
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.active = false;
    this.revision++;
    this.disposed = true;
    window.removeEventListener('resize', this.refresh);
    window.removeEventListener('orientationchange', this.refresh);
    this.viewport?.removeEventListener('resize', this.refresh);
    this.orientation?.removeEventListener('change', this.refresh);
    document.removeEventListener('fullscreenchange', this.fullscreenChanged);
    this.releaseNativeLayout();
    this.refresh();
  }

  private current(revision: number): boolean {
    return !this.disposed && this.active && this.revision === revision;
  }

  private async enterNativeLayout(revision: number): Promise<void> {
    const element = document.documentElement;
    // Call synchronously from the Play button's gesture, before the first await.
    if (!document.fullscreenElement && typeof element.requestFullscreen === 'function') {
      try {
        await element.requestFullscreen({ navigationUI: 'hide' });
        this.fullscreenOwned = document.fullscreenElement === element;
      } catch {
        // Safari and embedded browsers can keep using the rotated CSS layout.
      }
    }
    if (!this.current(revision)) {
      this.releaseNativeLayout();
      return;
    }

    const lock = this.orientation?.lock;
    if (typeof lock !== 'function') return;
    try {
      await lock.call(this.orientation, 'landscape');
      this.orientationOwned = true;
    } catch {
      // The browser may require fullscreen or may not implement orientation lock.
    }
    if (!this.current(revision)) this.releaseNativeLayout();
  }

  private releaseNativeLayout(): void {
    if (this.orientationOwned) {
      this.orientationOwned = false;
      try { this.orientation?.unlock?.(); } catch { /* Browser already unlocked. */ }
    }
    if (this.fullscreenOwned) {
      this.fullscreenOwned = false;
      // Never close a fullscreen session that belongs to another page element.
      if (document.fullscreenElement === document.documentElement && typeof document.exitFullscreen === 'function') {
        try { void document.exitFullscreen().catch(() => {}); } catch { /* Fullscreen already closed. */ }
      }
    }
  }

  private readonly fullscreenChanged = (): void => {
    if (document.fullscreenElement !== document.documentElement) this.fullscreenOwned = false;
    this.refresh();
  };

  private readonly refresh = (): void => {
    const rotated = this.active && !this.disposed && window.innerHeight > window.innerWidth;
    if (document.body.classList.contains('phone-rotated') === rotated) return;
    document.body.classList.toggle('phone-rotated', rotated);
    this.onLayoutChange();
  };
}
