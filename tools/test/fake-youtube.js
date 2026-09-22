/* 本物の YouTube IFrame API の代わりに読ませるスタブ。
   ライブ配信の再現ポイント（いずれも実機で確認した挙動）:
     - getDuration() は「実際の再生位置とは別の軸」の値を返す（序盤 3600 にパディング）
     - seekTo() は [LIVE端-DVR, LIVE端] にクランプされる（先を指すと LIVE端に張り付く）
     - 再生が始まるまで getCurrentTime() は 0 を返す
     - 配信者が DVR を無効にしたライブは seekTo を黙って無視する（CFG.noDvr）
     - 配信が終わると再生が止まり ENDED になる（endStream()）
     - アーカイブ（CFG.archive）は普通の動画。isLive が false で、getDuration() は
       再生位置と同じ軸の「終端」を返し、頭から終端まで自由にシークできる
   本物に無いもの: seek の着地遅延、セグメント粒度、LIVE端への自動追いつき。
   ここで通っても実機で動く保証にはならないので、トランスポートを変えたら
   実際の配信でも確かめること。 */
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
    // アーカイブ（配信済みの動画）は endAt で長さが決まり、伸びない
    this.live = (CFG.archive || []).indexOf(opt.videoId) < 0;
    // 長さは動画ごとに変えられる（CFG.lengths）。既定は ELAPSED0
    this.endAt = this.live ? null
               : ((CFG.lengths && CFG.lengths[opt.videoId]) || ELAPSED0);
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
  // LIVE端。配信開始からの経過秒。実時間と同じ速さで進む。
  // アーカイブになったら伸びない（終端で固定）
  FakePlayer.prototype.edge = function(){
    return this.endAt != null ? this.endAt : ELAPSED0 + (now() - this.t0);
  };
  FakePlayer.prototype.floor = function(){
    return this.live ? Math.max(0, this.edge() - DVR) : 0;   // アーカイブは先頭まで戻れる
  };
  /* 配信終了。本物は再生が止まって ENDED になる。アーカイブへの切り替わりは
     ページを読み直したときに起きるので、ここでは再現しない */
  FakePlayer.prototype.endStream = function(){
    this.posBase = this.pos(); this.posWall = now(); this.playing = false;
    this.setState(0);
  };
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
  // ここが不具合の核。ライブでは再生位置と同じ軸に乗らない値を返す。
  // アーカイブになると素直に終端を返す
  FakePlayer.prototype.getDuration = function(){
    return this.live ? Math.max(PAD, this.edge()) : this.endAt;
  };
  // 配信者が DVR を無効にしたライブ（CFG.noDvr に動画IDを並べる）。
  // 制限が掛かるのは配信中だけ
  FakePlayer.prototype.noDvr = function(){
    return this.live && (CFG.noDvr || []).indexOf(this.videoId) >= 0;
  };
  FakePlayer.prototype.getVideoData = function(){
    return { video_id: this.videoId, isLive: this.live, allowLiveDvr: !this.noDvr() };
  };
  FakePlayer.prototype.seekTo = function(t){
    const lo = this.floor(), hi = this.edge();
    const clamped = Math.min(hi, Math.max(lo, t));
    // 本物は DVR 無効の配信への seekTo をエラーも出さずに無視する（実機で確認）
    if(this.noDvr()){ this.seekLog.push({asked: t, got: null, edge: hi, ignored: true}); return; }
    this.seekLog.push({asked: t, got: clamped, edge: hi});
    this.posBase = clamped;
    this.posWall = now();
  };
  FakePlayer.prototype.playVideo = function(){
    if(!this.started){
      // ライブは再生が始まった瞬間に LIVE端へ着く。アーカイブは頭から
      this.started = true;
      this.posBase = this.live ? this.edge() : 0;
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
