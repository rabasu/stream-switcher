# トランスポートの回帰テスト

シーク / LIVE / 一時停止 / 再生速度が、**画面の表示だけでなく実際のプレーヤーで**
意図どおり動いているかを確かめる。

## 背景

`public/` は YouTube IFrame API に強く依存していて、次の2つを踏むと
「UI は動いたように見えるのに、実際の映像はまったく動かない」不具合になる。
過去に実際に起きているので、テストで固定してある。

1. **LIVE端の基準に `getDuration()` を使わない。**
   YouTube のライブでは `getDuration()` が再生位置と同じ軸に乗らず、序盤は
   3600 などにパディングされた値を返す。これを基準に `seekTo()` すると常に
   LIVE端より先を指してクランプされ、シークが一切効かなくなる。
   基準は `getCurrentTime()` の実測だけで作ること。

2. **画面には「押した結果」ではなくプレーヤーの実状態を出す。**
   要求値をそのまま描くと、シークや速度変更が失敗しても UI 上は成功した
   ように見え、不具合が画面から隠れる。実測と食い違ったら実測へ寄せる。

## 仕組み

`public/` をそのまま読み込み、`https://www.youtube.com/iframe_api` だけを
`fake-youtube.js` に差し替えてヘッドレス Chromium で動かす。偽プレーヤーは
本物のライブが持つ厄介な性質を再現している。

- `getDuration()` が再生位置と別の軸の値を返す（序盤は 3600 にパディング）
- `seekTo()` が `[LIVE端 - DVR, LIVE端]` にクランプされる
- 再生が始まるまで `getCurrentTime()` が 0 を返す

判定は偽プレーヤーの再生位置を直接読んで行う。表示だけを見ても意味がない。

## 実行

```sh
npm i -g playwright && npx playwright install chromium
node tools/test/transport.test.js               # public/ を検証
node tools/test/transport.test.js <publicDir>   # 任意のディレクトリを検証
```

Chromium の場所は環境変数 `PW_CHROMIUM` で指定できる。
失敗があると終了コード 1。
