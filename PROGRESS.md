# 捉迷藏 APP 目前狀態

更新時間：2026-05-27

## 已完成

- 大改版為多階段流程：
  - 位置授權
  - Google / Email 登入
  - 開局
  - 選擇紅隊或綠隊
  - 簡化地圖遊戲畫面
- 地圖改成 Carto light no labels，資訊量比原本 OpenStreetMap 少很多。
- `watchPosition` 持續定位，位置變化會節流同步到 Supabase。
- 新增 `supabase-config.js`，可放 Project URL 與 anon public key。
- 新增 Google OAuth 登入。
- Email 註冊/登入保留為備用。
- 新增 `player_profiles` 表，保存玩家基本資料。
- `game_players` 保存即時位置與隊伍。
- 關閉瀏覽器前用 Supabase REST + `keepalive` 嘗試標記離線。
- 公開預覽 tunnel 已啟動：
  - `https://eighty-planes-type.loca.lt`
- 玩家視角已改成只看敵隊位置：
  - 紅隊看綠隊。
  - 綠隊看紅隊。
  - 不顯示隊友位置。
- 已建立獨立控制台網站：
  - 資料夾：`C:\Users\xuan9\Desktop\給codex運行的資料夾\捉迷藏控制台`
  - 本機：`http://127.0.0.1:5178`
  - 公開：`https://afraid-rats-refuse.loca.lt`

## 已實測

- `node --check app.js`
- `node --check server.mjs`
- 本機 `http://127.0.0.1:5177/` 可開啟。
- 公開 tunnel 回傳新版 HTML。
- 控制台本機 `http://127.0.0.1:5178/` 可開啟。
- 控制台公開 tunnel 回傳控制台 HTML。
- 已建立控制員帳號 `stu310101@shsh.tw`，並加入 `control_operators`。
- 已用控制員帳號登入控制台，確認可監看 `main` 房間。
- Browser 實際操作：
  - 進站會先停在位置授權畫面。
  - 定位被拒絕時會顯示錯誤。
  - 使用模擬位置後會進入登入畫面。
  - 未設定 Supabase 時 Google / Email 登入會禁用。
  - Console 無 error / warning。

## 尚未實測

- 真 Supabase Google OAuth 登入。
- 真實遠端資料表寫入。
- 兩個不同玩家裝置即時同步。
- 兩台以上真實裝置同時移動時的完整長時間定位同步。

原因：目前本機沒有此專案的 Supabase Project URL、anon key、Google provider 設定與可登入測試帳號。

## 下一步

1. 在 Supabase SQL Editor 執行 `supabase/schema.sql`。
2. 設定 Google provider。
3. 在 Supabase Auth URL Configuration 加入：
   - `http://127.0.0.1:5177/`
   - `https://eighty-planes-type.loca.lt/`
4. 將 Project URL / anon key 放進 `supabase-config.js` 或網頁設定欄位。
5. 用兩個帳號測試紅隊 / 綠隊視角與即時定位。
6. 註冊或登入控制員帳號後，把該帳號 user id 加入 `control_operators`。
