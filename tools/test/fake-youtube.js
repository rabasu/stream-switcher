/* 本物の YouTube IFrame API の代わりに読ませるスタブ。
   ライブ配信の再現ポイントは3つ:
     - getDuration() は「実際の再生位置とは別の軸」の値を返す（序盤 3600 にパディング）
     - seekTo() は [LIVE端-DVR, LIVE端] にクランプされる（先を指すと LIVE端に張り付く）
     - 再生が始まるまで getCurrentTime() は 0 を返す */
window.__FAKE = { players: {} };
(function(){
  const CFG = window.__FAKECFG || {};
  const ELAPSED0 = CFG.elapsed != null ? CFG.elapsed : 600;   // 配信開始からの経過(秒)
  const DVR      = CFG.dvr     != null ? CFG.dvr     : 100000; // さかのぼれる長さ(秒)
  const PAD      = CFG.pad     != null ? CFG.pad     : 3600;   // getDuration() のパディング

  function now(){ return performance.now() / 1000; }

  function FakePlayer(hostId, opt){
    const self = this;
    this.id = hostId;
    this.videoId = opt.videoId;
    this.t0 = now();
    this.started = false;
    this.playing = false;
    this.rate = 1;
    this.vol = 100;
    this.muted = true;
    this.posBase = 0;
    this.posWall = now();
    this.state = -1;
    this.seekLog = [];
    const host = document.getElementById(hostId);
    this.el = document.createElement('iframe');
    if(host && host.parentNode) host.parentNode.replaceChild(this.el, host);
    window.__FAKE.players[hostId] = this;

    this.events = opt.events || {};
    // 本物と同じく、コンストラクタが返ったあとに onReady が来る
    setTimeout(function(){
      self.setState(-1);
      if(self.events.onReady) self.events.onReady({target: self});
    }, 30);
  }
  // LIVE端。配信開始からの経過秒。実時間と同じ速さで進む
  FakePlayer.prototype.edge = function(){ return ELAPSED0 + (now() - this.t0); };
  FakePlayer.prototype.floor = function(){ return Math.max(0, this.edge() - DVR); };
  FakePlayer.prototype.setState = function(s){
    if(this.state === s) return;
    this.state = s;
    if(this.events.onStateChange) this.events.onStateChange({target:this, data:s});
  };
  FakePlayer.prototype.pos = function(){
    if(!this.started) return 0;
    let p = this.posBase + (this.playing ? (now() - this.posWall) * this.rate : 0);
    return Math.min(p, this.edge());       // LIVE端より先は再生できない
  };
  FakePlayer.prototype.getCurrentTime = function(){ return this.pos(); };
  // ここが不具合の核。再生位置と同じ軸に乗らない値を返す
  FakePlayer.prototype.getDuration = function(){ return Math.max(PAD, this.edge()); };
  FakePlayer.prototype.seekTo = function(t){
    const lo = this.floor(), hi = this.edge();
    const clamped = Math.min(hi, Math.max(lo, t));
    this.seekLog.push({asked: t, got: clamped, edge: hi});
    this.posBase = clamped;
    this.posWall = now();
  };
  FakePlayer.prototype.playVideo = function(){
    if(!this.started){
      // 再生が始まった瞬間に LIVE端へ着く（本物のライブと同じ）
      this.started = true;
      this.posBase = this.edge();
      this.posWall = now();
    }
    if(!this.playing){ this.posBase = this.pos(); this.posWall = now(); this.playing = true; }
    this.setState(1);
  };
  FakePlayer.prototype.pauseVideo = function(){
    if(this.playing){ this.posBase = this.pos(); this.posWall = now(); this.playing = false; }
    this.setState(2);
  };
  FakePlayer.prototype.setPlaybackRate = function(r){
    // ライブは 1x 以外を拒否することがある（CFG.lockRate で再現）
    if(CFG.lockRate && r !== 1) return;
    this.posBase = this.pos(); this.posWall = now(); this.rate = r;
  };
  FakePlayer.prototype.getPlaybackRate = function(){ return this.rate; };
  FakePlayer.prototype.getAvailablePlaybackRates = function(){
    return CFG.lockRate ? [1] : [0.25,0.5,1,1.25,1.5,2];
  };
  FakePlayer.prototype.getIframe = function(){ return this.el; };
  FakePlayer.prototype.setVolume = function(v){ this.vol = v; };
  FakePlayer.prototype.getVolume = function(){ return this.vol; };
  FakePlayer.prototype.mute = function(){ this.muted = true; };
  FakePlayer.prototype.unMute = function(){ this.muted = false; };
  FakePlayer.prototype.isMuted = function(){ return this.muted; };
  FakePlayer.prototype.destroy = function(){ delete window.__FAKE.players[this.id]; };

  window.YT = {
    Player: FakePlayer,
    PlayerState: {UNSTARTED:-1, ENDED:0, PLAYING:1, PAUSED:2, BUFFERING:3, CUED:5}
  };
  // アプリが onYouTubeIframeAPIReady を定義したら呼ぶ
  const iv = setInterval(function(){
    if(typeof window.onYouTubeIframeAPIReady === 'function'){
      clearInterval(iv);
      window.onYouTubeIframeAPIReady();
    }
  }, 10);
})();
