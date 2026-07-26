'use strict';

class ShinyHuntBot {
  constructor(g, pushStateFn) {
    this.g = g;
    this.pushState = pushStateFn || (() => {});
    this.running = false;
    this.huntList = [];
    this.currentIndex = 0;
    this.state = 'idle';
    this.waitTimer = null;
    this.failsafeTimer = null;
    this.pauseTick = null;
    this.rotationsCompleted = 0;
    this.nextPauseAt = 0;
    this.pauseUntil = 0;
    this.missChance = 0.03;
  }

  start(huntList) {
    if (!huntList || !huntList.length) return false;
    this.huntList = [...huntList];
    this.running = true;
    this.currentIndex = 0;
    this.rotationsCompleted = 0;
    this._scheduleNextPause();
    // começa voltando pra Cerulean (só na partida), depois entra na primeira hunt
    this._returnToCerulean();
    return true;
  }

  stop() {
    this.running = false;
    this._clearTimers();
    this.state = 'idle';
    this.pushState();
  }

  _clearTimers() {
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    if (this.failsafeTimer) { clearTimeout(this.failsafeTimer); this.failsafeTimer = null; }
    if (this.pauseTick) { clearInterval(this.pauseTick); this.pauseTick = null; }
  }

  _scheduleNextPause() {
    this.nextPauseAt = this.rotationsCompleted + 3 + Math.floor(Math.random() * 3);
  }

  _returnToCerulean() {
    if (!this.running) return;
    this.state = 'returning';
    this.pushState();
    this._clearTimers();
    try {
      this.g.view.webContents.executeJavaScript(
        'window.__pczReturnCerulean && window.__pczReturnCerulean()', false
      ).catch(() => {});
    } catch {}
    this.waitTimer = setTimeout(() => {
      if (!this.running) return;
      if (this.state === 'returning') this._gotoHunt();
    }, 8000);
  }

  _gotoHunt() {
    if (!this.running) return;
    const item = this.huntList[this.currentIndex];
    if (!item) { this.currentIndex = 0; return this._gotoHunt(); }
    const extra = Math.random() * 2000;
    this.state = 'entering';
    this.pushState();
    this._clearTimers();
    this.waitTimer = setTimeout(() => {
      if (!this.running) return;
      try {
        this.g.view.webContents.executeJavaScript(
          'window.__pczGotoHunt && window.__pczGotoHunt(' + JSON.stringify(String(item.n)) + ')',
          false
        ).catch(() => {});
      } catch {}
      this.waitTimer = setTimeout(() => {
        if (!this.running) return;
        if (this.state === 'entering') this._advance();
      }, 10000);
    }, extra);
  }

  _onEvent(type) {
    if (!this.running) return;
    switch (type) {
      case 'field-init':
        if (this.state === 'returning') {
          // chegou em Cerulean (só na partida) → delay e entra na hunt
          this._clearTimers();
          const cd = 2000 + Math.random() * 4000;
          this.waitTimer = setTimeout(() => { this._gotoHunt(); }, cd);
        } else if (this.state === 'entering') {
          this._clearTimers();
          this.state = 'checking';
          this.pushState();
          this._startChecking();
        }
        break;
      case 'shiny_field':
        if ((this.state === 'checking' || this.state === 'entering') && this.g.state.shinyOnField) {
          if (this._shouldMiss()) break;
          this._clearTimers();
          this.state = 'shiny_found';
          this._startFailsafe();
          this.pushState();
        }
        break;
      case 'shiny_capture':
        if (this.state === 'shiny_found') {
          this._clearTimers();
          this._advance();
        }
        break;
      case 'profession_photo':
        if (this.state === 'shiny_found') {
          this._clearTimers();
          this.waitTimer = setTimeout(() => {
            if (!this.running) return;
            this._advance();
          }, 2000);
          this.pushState();
        }
        break;
    }
  }

  _shouldMiss() {
    return Math.random() < this.missChance;
  }

  _startChecking() {
    if (!this.running) return;
    const delay = this._debuffDelay();
    this.waitTimer = setTimeout(() => {
      if (!this.running) return;
      if (this.g.state.shinyOnField && !this._shouldMiss()) {
        this.state = 'shiny_found';
        this._startFailsafe();
        this.pushState();
      } else {
        this._advance();
      }
    }, delay);
  }

  // delay cobrindo o debuff de 1min do teleporte (Distorção de Teleporte)
  _debuffDelay() {
    const r = Math.random();
    if (r < 0.70) return 65000 + Math.random() * 10000;   // 70%: 65-75s
    if (r < 0.95) return 75000 + Math.random() * 10000;   // 25%: 75-85s
    return 85000 + Math.random() * 10000;                   // 5%: 85-95s
  }

  _startFailsafe() {
    this.failsafeTimer = setTimeout(() => {
      if (!this.running) return;
      this._advance();
    }, 5 * 60 * 1000);
  }

  _advance() {
    this._clearTimers();
    const prev = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.huntList.length;
    if (prev >= this.currentIndex && this.huntList.length > 1) {
      this.rotationsCompleted++;
    }
    if (this.rotationsCompleted >= this.nextPauseAt) {
      this._startPause();
      return;
    }
    this._gotoHunt();   // direto pra próxima hunt (sem Cerulean — debuff já cobre a troca)
  }

  _startPause() {
    const duration = 30000 + Math.floor(Math.random() * 60000);
    this.state = 'pausing';
    this.pauseUntil = Date.now() + duration;
    this.pushState();
    this.pauseTick = setInterval(() => { this.pushState(); }, 3000);
    this.waitTimer = setTimeout(() => {
      if (this.pauseTick) { clearInterval(this.pauseTick); this.pauseTick = null; }
      if (!this.running) return;
      this._shuffleList();
      this.currentIndex = 0;
      this.rotationsCompleted = 0;
      this._scheduleNextPause();
      this._gotoHunt();
    }, duration);
  }

  _shuffleList() {
    for (let i = this.huntList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.huntList[i], this.huntList[j]] = [this.huntList[j], this.huntList[i]];
    }
  }

  getStatus() {
    const pausing = this.state === 'pausing';
    return {
      running: this.running,
      state: this.state,
      currentHunt: this.huntList[this.currentIndex] || null,
      currentIndex: this.currentIndex,
      totalHunts: this.huntList.length,
      pauseRemainingSec: pausing ? Math.max(0, Math.ceil((this.pauseUntil - Date.now()) / 1000)) : 0,
    };
  }
}

module.exports = { ShinyHuntBot };
