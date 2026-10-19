# Karaoke Studio for YouTube — Output-first MVP (v0.2.0)

這是一個 **Chrome / Edge Manifest V3 擴充功能原型**。在本機處理目前 YouTube 分頁的輸出音訊，不使用雲端處理，不會下載或匯出影片音訊。

## 安裝

1. 將 `youtube-karaoke-mvp.zip` 解壓縮至固定資料夾。
2. Chrome 開啟 `chrome://extensions`（Edge 開啟 `edge://extensions`）。
3. 開啟右上角 **開發人員模式**。
4. 選擇 **載入未封裝項目（Load unpacked）**，指定解壓縮資料夾（內有 `manifest.json`）。
5. 開啟 YouTube 播放影片，點擊擴充功能圖示 → **開始處理音訊**。
6. 調整 Pitch / Tempo，並在 **Vocal / Channel Mode** 選擇 Stereo、Left Only、Right Only 或 Center Reduction。
7. 若選 Center Reduction，可使用 Reduction Strength 調整中央訊號抵消強度。按下「停止處理 · 恢復原音」便切回正常 YouTube 輸出。

需要 Chrome / Edge **116 或更新版本**。可在 YouTube 與 YouTube Music 使用；以桌面版 Chrome 為主要目標。

## 功能

| 功能 | 範圍 | 實作方式 |
| --- | --- | --- |
| Pitch / Key | −12 ～ +12 半音 | 本機 AudioWorklet FFT / phase-vocoder，即時變調 |
| Tempo | 0.50× ～ 1.50× | YouTube `<video>.playbackRate` + `preservesPitch = true` |
| Channel Mode | Stereo / Left Only / Right Only / Center Reduction | 左右聲道切換與雙耳單聲道複製；或中央訊號抵消 |
| Center Reduction Strength | 0～100% | 僅在 Center Reduction 模式下有效 |
| Bass / Treble | −12 ～ +12 dB | Web Audio BiquadFilter |
| Output Volume | 0～100% | Web Audio GainNode |
| 預設 | Original / Karaoke / Practice | 內建快速參數 |
| 保留操作狀態 | Yes | 將設定儲存在瀏覽器內的 `chrome.storage.local` |
| 麥克風 / 自己人聲效果 | **未實作** | 下一階段 |

## 架構

```text
YouTube tab audio
    ↓ chrome.tabCapture.getMediaStreamId (service worker)
Offscreen document getUserMedia()  ← keeps processing after popup closes
    ↓ MediaStreamAudioSourceNode
AudioWorklet: local STFT pitch shifter
    ↓
Stereo channel matrix: Stereo / L→both / R→both / Center Reduction
    ↓
Lowshelf EQ → Highshelf EQ → Output Gain
    ↓
AudioContext.destination (your default system output)
```

Tempo 在 YouTube 播放器的 `<video>` 層處理，和 AudioWorklet 變調分開。這樣調整 Tempo 並不改變 Key；Key 變化也不會影響 YouTube 影片的播放長度。只有**一個** YouTube 分頁可同時啟用音效處理。

## 目前已知限制（重要）

- **音質尚未通過真實 YouTube 歌曲的端到端測試。** 使用合成 440 Hz 測試訊號確認基本變調頻率，但 FFT 處理對複雜音樂有可能造成顫動、金屬聲、延遲、相位與音量變化。
- 在部分分頁/平台權限設定下 `tabCapture` 可能無法啟動；使用者需要從擴充功能按鈕主動開始擷取。
- Pitch worklet 約引入 43ms 的窗長延遲（以 48kHz 計），加上瀏覽器的音訊緩衝與裝置延遲。極端 Key 調整會有音質損失。
- **Left Only / Right Only**：僅輸出選定聲道，並複製到左右兩側（dual mono）。若原唱與伴奏確實被分在不同聲道，可直接切到伴奏聲道；對一般左右聲道都含原唱的 Stereo 歌曲，無法完整去人聲。
- **Center Reduction 不是 AI 人聲分離**：僅能抵消部分置中聲音，可能同時減少鼓、貝斯等置中樂器。對 Mono 音訊可能使整段音量大幅下降甚至接近靜音。
- 無法只把人聲去除而保證所有樂器原封不動。
- 音訊最後從系統預設輸出裝置播放，尚無擴充功能內部的輸出裝置選擇器。
- 停止時恢復播放器啟動前的播放速度；如果 YouTube 在擴充功能執行期間強行修改速度，介面與 YouTube 自己的速度選單可能暫時不一致。
- 新增聲道模式的純程式測試（四種路由、強度、舊版設定遷移）已通過；仍未能在此環境完成新版 Chrome UI／YouTube 實機整合驗證，請先作為測試版載入。

## 從 v0.1 升級至 v0.2

1. 在 `chrome://extensions` 卸載舊版或移除原先的解壓縮檔案，改載入 v0.2 的解壓縮資料夾。若希望保留舊設定，建議以**相同擴充功能安裝位置**覆蓋檔案，並按「重新載入」。
2. 舊設定若存在 Vocal Reduction 強度且大於 0，會自動對應 **Center Reduction**；否則預設為 Original Stereo。
3. Karaoke / Practice 預設改成 Center Reduction；Original 預設為 Stereo。
4. 測試檢查可在原始碼資料夾執行 `node test-routing.js`、`node test-background.js`（訊息來源與擷取生命週期），另可執行原有 `node test-audio.js`（會輸出測試音訊資料）。

## 隱私

沒有後端、第三方音訊 SDK 或遠端音訊上傳。只處理使用者明確選定的 YouTube 分頁。程式碼與音訊運算完全封裝在擴充功能中；需要 `tabCapture`、`offscreen`、YouTube 頁面權限與本機設定儲存權限。

## 下一階段建議

1. 在真實音樂上比較不同 Pitch 的音質，視結果改用 SoundTouch / WASM DSP 等更成熟演算法（必須本機封裝）。
2. 增加每首歌曲的自訂設定與頻繁切換時的音量平滑化。
3. 麥克風輸入 → echo / reverb → 混音 → 耳機監聽、延遲調校。
4. 視需求增加 YouTube 播放器上方的小型浮動控制器與 Side Panel。

