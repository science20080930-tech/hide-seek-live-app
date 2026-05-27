# 捉迷藏即時定位 APP

本專案是網頁版捉迷藏原型，流程改成：

1. 進站先要求精確定位。
2. 定位成功後進入玩家登入。
3. 使用 Supabase Auth 的 Email/密碼註冊與登入。
4. 登入後按「開局」，每局重新選擇紅隊或綠隊。
5. 進入簡化地圖，持續同步玩家位置，直到瀏覽器關閉或登出。

## 本機執行

```powershell
node server.mjs
```

打開：

```text
http://127.0.0.1:5177
```

## Supabase 設定

1. 到 Supabase 建立 project。
2. 在 SQL Editor 執行：

```text
supabase/schema.sql
```

3. 到 Project Settings / API 複製：

- Project URL
- anon public key

4. 目前已直接寫入 `supabase-config.js`：

```js
export const SUPABASE_CONFIG = {
  url: "https://你的專案.supabase.co",
  anonKey: "你的 anon public key",
};
```

## 已完成

- 位置授權閘門。
- 高精度 `watchPosition` 持續定位，設定為不使用快取位置。
- 進入後會先進行 GPS 暖機取樣，採用誤差半徑最小的位置上傳。
- 後續會忽略比目前更粗略、且不像真實移動的飄移點。
- Supabase Email/密碼註冊與登入。
- `player_profiles` 保存玩家基本資料。
- `game_players` 保存房間、隊伍、座標、在線狀態。
- Supabase Realtime `postgres_changes` 同步同房間玩家。
- RLS 控制視角：
  - 紅隊只能讀自己與綠隊玩家。
  - 綠隊只能讀自己與紅隊玩家。
  - 隊友位置不會顯示。
- 關閉瀏覽器前會用 `keepalive` 嘗試標記離線。
- 簡化版無標籤地圖底圖。

## 正式上線網址

玩家網站：

```text
https://science20080930-tech.github.io/hide-seek-live-app/
```

控制台：

```text
https://science20080930-tech.github.io/hide-seek-control/
```

## 本機臨時預覽

目前使用本機 tunnel：

```text
https://eighty-planes-type.loca.lt
```

這個網址依賴本機電腦和 tunnel 程序持續運行；若重開 tunnel，網址可能會改變。

## 獨立控制台

控制台已放在另一個資料夾：

```text
C:\Users\xuan9\Desktop\給codex運行的資料夾\捉迷藏控制台
```

本機網址：

```text
http://127.0.0.1:5178
```

正式上線：

```text
https://science20080930-tech.github.io/hide-seek-control/
```

本機 tunnel 預覽：

```text
https://afraid-rats-refuse.loca.lt
```

控制台會讀取紅隊與綠隊所有玩家位置。請先重新執行最新 `supabase/schema.sql`，並把控制員帳號加入 `control_operators`。
