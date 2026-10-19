# Chrome 線上應用程式商店上架資料

## 素材

擴充功能介面支援英文（預設）與繁體中文，依瀏覽器語言自動切換。商店的每個語言可以上傳各自的截圖：

| 檔案（`en/` 與 `zh_TW/` 各一份） | 規格 | 用途 |
|---|---|---|
| `screenshot-1-panel.png` | 1280×800 | 影片下方控制面板 |
| `screenshot-2-popup.png` | 1280×800 | 工具列視窗的完整控制項 |
| `screenshot-3-channel-detection.png` | 1280×800 | 立體聲／單聲道偵測 |
| `promo-tile-440x280.png` | 440×280 | 小型宣傳圖塊 |
| `../extension/icons/icon128.png` | 128×128 | 商店圖示（共用；主體 96×96，四周 16px 透明留白） |

截圖中的影片畫面是示意用的漸層，不含任何 YouTube 影片內容或標誌。

## 基本資料

- **名稱**：Karaoke Studio for YouTube（由 `_locales` 提供，兩種語言相同）
- **類別**：娛樂
- **預設語言**：English；另提供中文（繁體）
- **簡短說明**：商店直接使用 manifest 的 `description`，也就是 `_locales/*/messages.json` 的 `extDescription`，不需另外填寫。

## 中文（繁體）商店說明

### 詳細說明

Karaoke Studio 把 YouTube 變成練唱工具。在影片頁按一下擴充功能圖示開始處理，就能即時調整正在播放的音訊。

主要功能
• 升降 Key：±12 個半音，播放速度不變。
• 兩種變調引擎：「高音質」在大幅升降 Key 時音質較好（變調時延遲約 120 毫秒）；「低延遲」延遲約 43 毫秒。
• 辨識原調：開始處理約 10 秒後顯示歌曲的調（例如 G 大調），變調時同步顯示目前的調（例如 −2 → F 大調），方便記住自己適合的 Key。調性是依音訊估計的，可能把關係大小調（如 C 大調與 A 小調）互相誤判。
• 變速不變調：0.5× 到 1.5×，音高不變。
• 聲道模式：原始立體聲、只聽左聲道、只聽右聲道、弱化人聲。
• 弱化人聲只處理人聲所在的頻段，低音、大鼓與高頻的鈸會保留。
• 自動偵測聲道：標示影片是立體聲還是單聲道。單聲道的影片無法用左右聲道切換或弱化人聲，會直接提醒你。
• 音色：低音、高音、輸出音量，內建 Original／Karaoke／Practice 預設。
• 影片下方面板（選用）：在工具列視窗勾選後，從擴充功能開始處理，面板就會出現在影片下方，不必再開啟視窗。
• 快捷鍵：Alt+Shift+K 開始／停止（可在 chrome://extensions/shortcuts 修改）。
• 關閉視窗後仍持續處理；按停止即恢復原音。
• 介面支援繁體中文與英文。

使用方式
1. 開啟 YouTube 影片。
2. 點擴充功能圖示，按「開始處理音訊」，或按 Alt+Shift+K。
3. 調整 Key、速度與聲道模式。

限制
• 「弱化人聲」是用左右聲道相減，消除置中的聲音，不是 AI 人聲分離。人聲置中的立體聲錄音效果最好；同頻段的置中樂器也會一起減弱。
• Chrome 規定擷取分頁音訊前，必須由使用者點擊擴充功能圖示或按快捷鍵授權。重新整理頁面後要再啟動一次。
• 同一時間只能處理一個分頁。

隱私
所有音訊都在你的瀏覽器裡處理，不會上傳；不收集、不傳送任何個人資料，也沒有分析或追蹤程式。

開放原始碼（MIT）：https://github.com/unickhow/karaoke_studio_for_youtube

## English store listing

### Detailed description

Karaoke Studio turns YouTube into a singing practice tool. Click the extension icon on a video and adjust the audio that is playing, live.

Features
• Change key: ±12 semitones without changing playback speed.
• Two pitch engines: "High quality" sounds better on large key changes (about 120 ms delay while shifting); "Low latency" has about 43 ms delay.
• Key detection: about 10 seconds after starting, shows the song's key (e.g. G major) and the key after your shift (e.g. −2 → F major), so you can remember which key suits you. The key is estimated from the audio and relative major/minor keys (e.g. C major and A minor) can be confused.
• Change speed without changing key: 0.5× to 1.5×.
• Channel modes: original stereo, left only, right only, reduce vocals.
• Vocal reduction only works on the vocal frequency range, so bass, kick drum and cymbals are kept.
• Channel detection: shows whether a video is stereo or mono. Mono videos cannot use channel picking or vocal reduction, and you are told so.
• Tone: bass, treble and output volume, with Original / Karaoke / Practice presets.
• Optional panel under the video: turn it on in the popup, start processing from the extension, and control everything below the video without opening the popup.
• Shortcut: Alt+Shift+K to start or stop (change it at chrome://extensions/shortcuts).
• Keeps running after the popup closes; stop to get the original audio back.
• Interface in English and Traditional Chinese.

How to use
1. Open a YouTube video.
2. Click the extension icon and press "Start processing audio", or press Alt+Shift+K.
3. Adjust key, speed and channel mode.

Limitations
• "Reduce vocals" subtracts the left and right channels to remove centered sound. It is not AI vocal separation. It works best on stereo recordings with centered vocals; centered instruments in the same range are reduced too.
• Chrome requires you to click the extension icon or press the shortcut before a tab's audio can be captured. After reloading the page, start it again.
• Only one tab can be processed at a time.

Privacy
All audio is processed in your browser and never uploaded. No personal data is collected or sent, and there is no analytics or tracking.

Open source (MIT): https://github.com/unickhow/karaoke_studio_for_youtube

## 隱私權實踐（開發人員資訊主頁）

### 單一用途說明

即時調整使用者正在觀看的 YouTube 影片音訊（變調、變速、聲道切換、弱化人聲、等化），用於卡拉 OK 練唱。

### 權限理由

| 權限 | 理由 |
|---|---|
| `activeTab` | 使用者點擊擴充功能圖示或按快捷鍵時，取得目前分頁的暫時授權，才能擷取該分頁的音訊。 |
| `tabCapture` | 擷取使用者所選 YouTube 分頁的音訊，在本機進行變調與聲道處理後播放。 |
| `offscreen` | 在 offscreen 文件中執行 Web Audio 處理，讓工具列視窗關閉後音效仍能持續。 |
| `storage` | 在本機儲存使用者的設定（Key、速度、聲道模式、等化、面板開關）。 |
| 主機權限 `youtube.com`、`www.youtube.com`、`music.youtube.com` | 在 YouTube 頁面注入內容腳本，用於調整影片播放速度，並顯示選用的影片下方控制面板。 |

### 遠端程式碼

否。所有程式碼都打包在擴充功能內。變調引擎 Signalsmith Stretch（MIT 授權）是隨附的 WebAssembly 模組，因此 CSP 加入 `'wasm-unsafe-eval'`，僅用於編譯這個隨附的 WASM，不會執行任何外部程式碼。

### 資料使用

- 不收集任何使用者資料（以上類別全部不勾選）。
- 聲明：不出售資料給第三方；不將資料用於與單一用途無關的目的；不將資料用於判斷信用或放貸。

### Privacy practices (English, for the review form)

- **Single purpose**: Adjusts the audio of the YouTube video the user is watching (key, speed, channel selection, vocal reduction, EQ) for karaoke practice.
- **activeTab**: Grants temporary access to the current tab when the user clicks the extension icon or presses the shortcut, which is required to capture that tab's audio.
- **tabCapture**: Captures the audio of the YouTube tab the user chose, processes it locally (key and channel changes) and plays it back.
- **offscreen**: Runs the Web Audio processing in an offscreen document so the effects keep running after the popup closes.
- **storage**: Saves the user's settings (key, speed, channel mode, EQ, panel switch) locally.
- **Host permissions (youtube.com, www.youtube.com, music.youtube.com)**: Injects a content script on YouTube pages to change the video's playback speed and show the optional control panel under the video.
- **Remote code**: No. All code ships in the package. The pitch engine, Signalsmith Stretch (MIT), is a bundled WebAssembly module; the CSP adds 'wasm-unsafe-eval' only so that this bundled module can be compiled.
- **Data usage**: No user data is collected.

## 上傳套件

在專案根目錄執行：

```sh
cd extension && zip -r -X ../dist/karaoke-studio-for-youtube-$(node -p "require('./manifest.json').version").zip . -x '.DS_Store'
```
