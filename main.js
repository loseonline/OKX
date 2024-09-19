require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const readline = require("readline");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const glob = require("glob");
const TelegramBot = require("node-telegram-bot-api");

const SESSION_FOLDER = __dirname;

// Initialize Telegram Bot with Markdown parsing mode
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
});

// List of authorized Telegram user IDs
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS.split(",").map((id) =>
  parseInt(id.trim())
);

class OKX {
  constructor() {
    this.apiId = Number(process.env.API_ID);
    this.apiHash = process.env.API_HASH;
    this.sessionPath = path.join(__dirname, "session");
    this.dataPath = path.join(__dirname, "data.txt");
    this.deviceModel = "LoseOnline OKX Racer";
    this.axiosInstance = axios.create({
      httpsAgent: new (require("https").Agent)({ rejectUnauthorized: true }),
    });
    this.retryCount = 3;
    this.retryDelay = 1000;
    this.telegramChatId = null;
    this.telegramMessageId = null;
    this.stats = {
      totalAccounts: 0,
      winsCount: 0,
      lossesCount: 0,
      totalProfit: 0,
      dailyTasksCompleted: 0,
      upgradesPerformed: 0,
      lastUpdateTime: null,
    };
    this.updateInterval = 5 * 60 * 1000; // Update every 5 minutes
    this.lastUpdateTime = Date.now();
    this.isBotActive = false;
    this.lastActivityTime = null;
  }

  headers() {
    return {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "App-Type": "web",
      "Content-Type": "application/json",
      Origin: "https://www.okx.com",
      Referer:
        "https://www.okx.com/mini-app/racer?tgWebAppStartParam=linkCode_88910038",
      "Sec-Ch-Ua":
        '"Not/A)Brand";v="8", "Chromium";v="126", "Microsoft Edge";v="126"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      "X-Cdn": "https://www.okx.com",
      "X-Locale": "en_US",
      "X-Utc": "7",
      "X-Zkdex-Env": "0",
    };
  }

  async postToOKXAPI(extUserId, extUserName, queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/info?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    const payload = {
      extUserId: extUserId,
      extUserName: extUserName,
      gameId: 1,
      linkCode: "88910038",
    };
    await this.updateStats("api_call", { type: "postToOKXAPI" });
    return this.retryRequest(() =>
      this.axiosInstance.post(url, payload, { headers })
    );
  }

  async assessPrediction(extUserId, predict, queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/assess?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    const payload = {
      extUserId: extUserId,
      predict: predict,
      gameId: 1,
    };
    await this.updateStats("api_call", { type: "assessPrediction" });
    return this.retryRequest(() =>
      this.axiosInstance.post(url, payload, { headers })
    );
  }

  async checkDailyRewards(extUserId, queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/tasks?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    try {
      const response = await this.retryRequest(() =>
        this.axiosInstance.get(url, { headers })
      );
      if (response.data && response.data.data) {
        const tasks = response.data.data;
        const dailyCheckInTask = tasks.find((task) => task.id === 4);
        if (dailyCheckInTask) {
          if (dailyCheckInTask.state === 0) {
            await this.performCheckIn(extUserId, dailyCheckInTask.id, queryId);
          } else {
            await this.updateStats("daily_task", { completed: false });
          }
        }
      }
    } catch (error) {
      await this.updateStats("error", {
        type: "checkDailyRewards",
        message: error.message,
      });
    }
  }

  async performCheckIn(extUserId, taskId, queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/task?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    const payload = {
      extUserId: extUserId,
      id: taskId,
    };
    try {
      await this.retryRequest(() =>
        this.axiosInstance.post(url, payload, { headers })
      );
      await this.updateStats("daily_task", { completed: true });
    } catch (error) {
      await this.updateStats("error", {
        type: "performCheckIn",
        message: error.message,
      });
    }
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitWithCountdown(minutes) {
    for (let i = minutes; i >= 0; i--) {
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(
        `===== Tüm hesaplar tamamlandı, döngüye devam etmek için ${i} dakika bekleniyor =====`
      );
      await this.sleep(60000);
    }
    console.log("");
  }

  async countdown(seconds) {
    for (let i = seconds; i >= 0; i--) {
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`[*] Devam etmek için ${i} saniye bekleyin ...`);
      await this.sleep(1000);
    }
    console.log("");
  }

  extractUserData(queryId) {
    const urlParams = new URLSearchParams(queryId);
    const userParam = urlParams.get("user");
    if (!userParam) {
      throw new Error(`Geçersiz query: ${queryId}`);
    }
    const user = JSON.parse(decodeURIComponent(userParam));
    return {
      extUserId: user.id,
      extUserName: user.username,
    };
  }

  async getBoosts(queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/boosts?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    try {
      const response = await this.retryRequest(() =>
        this.axiosInstance.get(url, { headers })
      );
      if (response.data && response.data.data) {
        return response.data.data;
      }
      return [];
    } catch (error) {
      await this.updateStats("error", {
        type: "getBoosts",
        message: error.message,
      });
      return [];
    }
  }

  async useBoost(queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/boost?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    const payload = { id: 1 };
    try {
      const response = await this.retryRequest(() =>
        this.axiosInstance.post(url, payload, { headers })
      );
      if (response.data && response.data.code === 0) {
        await this.updateStats("boost_use", { type: "fuelTank" });
        await this.countdown(5);
      }
    } catch (error) {
      await this.updateStats("error", {
        type: "useBoost",
        message: error.message,
      });
    }
  }

  async upgradeFuelTank(queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/boost?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    const payload = { id: 2 };
    try {
      const response = await this.retryRequest(() =>
        this.axiosInstance.post(url, payload, { headers })
      );
      if (response.data && response.data.code === 0) {
        await this.updateStats("upgrade", { type: "fuelTank" });
      }
    } catch (error) {
      await this.updateStats("error", {
        type: "upgradeFuelTank",
        message: error.message,
      });
    }
  }

  async upgradeTurbo(queryId) {
    const url = `https://www.okx.com/priapi/v1/affiliate/game/racer/boost?t=${Date.now()}`;
    const headers = { ...this.headers(), "X-Telegram-Init-Data": queryId };
    const payload = { id: 3 };
    try {
      const response = await this.retryRequest(() =>
        this.axiosInstance.post(url, payload, { headers })
      );
      if (response.data && response.data.code === 0) {
        await this.updateStats("upgrade", { type: "turboCharger" });
      }
    } catch (error) {
      await this.updateStats("error", {
        type: "upgradeTurbo",
        message: error.message,
      });
    }
  }

  async getCurrentPrice() {
    const url = "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT";
    try {
      const response = await this.retryRequest(() =>
        this.axiosInstance.get(url)
      );
      if (
        response.data &&
        response.data.data &&
        response.data.data.length > 0
      ) {
        return parseFloat(response.data.data[0].last);
      }
      throw new Error("Fiyat verisi bulunamadı");
    } catch (error) {
      await this.updateStats("error", {
        type: "getCurrentPrice",
        message: error.message,
      });
      return null;
    }
  }

  async createSession(phoneNumber, sessionName) {
    try {
      if (typeof this.apiId !== "number" || typeof this.apiHash !== "string") {
        throw new Error("Geçersiz API kimlik bilgileri");
      }

      const client = new TelegramClient(
        new StringSession(""),
        this.apiId,
        this.apiHash,
        {
          deviceModel: this.deviceModel,
          connectionRetries: 5,
        }
      );
      await client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => await input.text("Şifrenizi girin: "),
        phoneCode: async () =>
          await input.text("Aldığınız kodu girin: "),
        onError: (err) => {
          if (
            !err.message.includes("TIMEOUT") &&
            !err.message.includes("CastError")
          ) {
            console.error(`Telegram kimlik doğrulama hatası: ${err.message}`);
          }
        },
      });
      console.log("Yeni bir oturum başarıyla oluşturuldu!".green);
      const stringSession = client.session.save();
      const sessionId = sessionName || new Date().getTime();
      fs.writeFileSync(
        path.join(this.sessionPath, `session_${sessionId}.session`),
        stringSession
      );
      await client.sendMessage("me", {
        message: "Başarıyla yeni bir oturum oluşturuldu!",
      });
      console.log("Yeni oturumu oturum dosyasına kaydetti.".green);
      await client.disconnect();
    } catch (error) {
      if (
        !error.message.includes("TIMEOUT") &&
        !error.message.includes("CastError")
      ) {
        console.error(`Error: ${error.message}`.red);
      }
    }
  }

  async retrieveNewQueryData(sessionFile) {
    const sessionFilePath = path.join(this.sessionPath, `${sessionFile}`);
    try {
      const sessionString = fs.readFileSync(sessionFilePath, "utf8");
      const client = new TelegramClient(
        new StringSession(sessionString),
        this.apiId,
        this.apiHash,
        {
          deviceModel: this.deviceModel,
          connectionRetries: 5,
        }
      );
      await client.start({
        phoneNumber: async () => sessionFile,
        password: async () => await input.text("Şifrenizi girin: "),
        phoneCode: async () =>
          await input.text("Aldığınız kodu girin: "),
        onError: (err) => {
          if (
            !err.message.includes("TIMEOUT") &&
            !err.message.includes("CastError")
          ) {
            console.error(`Telegram kimlik doğrulama hatası: ${err.message}`);
          }
        },
      });
      try {
        const peer = await client.getInputEntity("OKX_official_bot");
        if (!peer) {
          console.error("Eş varlık alınamadı.");
          return;
        }
        const webview = await client.invoke(
          new Api.messages.RequestWebView({
            peer: peer,
            bot: peer,
            fromBotMenu: false,
            platform: "Android",
            url: "https://www.okx.com/",
          })
        );
        if (!webview || !webview.url) {
          console.error("Webview URL'si alınamadı.");
          return;
        }
        const query = decodeURIComponent(
          webview.url.split("&tgWebAppVersion=")[0].split("#tgWebAppData=")[1]
        );
        const currentData = fs
          .readFileSync(this.dataPath, "utf8")
          .split("\n")
          .filter(Boolean);

        if (!currentData.includes(query)) {
          fs.appendFileSync(this.dataPath, `${query}\n`);
          console.log("Yeni sorgu data.txt'ye kaydedildi".green);
        } else {
          console.log(
            "Sorgu zaten data.txt'de mevcut, kaydetme işlemi atlanıyor.".yellow
          );
        }
      } catch (e) {
        console.error(`Sorgu verileri alınırken hata oluştu: ${e.message}`.red);
      } finally {
        await client.disconnect();
      }
    } catch (error) {
      if (
        !error.message.includes("TIMEOUT") &&
        !error.message.includes("CastError")
      ) {
        console.error(`Error: ${error.message}`.red);
      }
    }
  }

  async replaceDeadQuery(sessionFile, lineIndex) {
    const sessionFilePath = path.join(this.sessionPath, `${sessionFile}`);
    try {
      const sessionString = fs.readFileSync(sessionFilePath, "utf8");
      const client = new TelegramClient(
        new StringSession(sessionString),
        this.apiId,
        this.apiHash,
        {
          deviceModel: this.deviceModel,
          connectionRetries: 5,
        }
      );
      await client.start({
        phoneNumber: async () => sessionFile,
        password: async () => await input.text("Şifrenizi girin: "),
        phoneCode: async () =>
          await input.text("Aldığınız kodu girin: "),
        onError: (err) => {
          if (
            !err.message.includes("TIMEOUT") &&
            !err.message.includes("CastError")
          ) {
            console.error(`Telegram kimlik doğrulama hatası: ${err.message}`);
          }
        },
      });
      try {
        const peer = await client.getInputEntity("OKX_official_bot");
        if (!peer) {
          console.error("Eş varlık alınamadı.");
          return;
        }
        const webview = await client.invoke(
          new Api.messages.RequestWebView({
            peer: peer,
            bot: peer,
            fromBotMenu: false,
            platform: "Android",
            url: "https://www.okx.com/",
          })
        );
        if (!webview || !webview.url) {
          console.error("Webview URL'si alınamadı.");
          return;
        }
        const query = decodeURIComponent(
          webview.url.split("&tgWebAppVersion=")[0].split("#tgWebAppData=")[1]
        );
        let currentData = fs
          .readFileSync(this.dataPath, "utf8")
          .split("\n")
          .filter(Boolean);

        if (!currentData.includes(query)) {
          currentData[lineIndex] = query;
          fs.writeFileSync(this.dataPath, currentData.join("\n") + "\n");
          console.log("Data.txt'deki ölü sorguyu yeni sorguyla değiştirdim".green);
        } else {
          console.log(
            "Sorgu zaten data.txt dosyasında mevcut, kaydetme işlemi atlanıyor.".yellow
          );
        }
      } catch (e) {
        console.error(`Sorgu verileri alınırken hata oluştu: ${e.message}`.red);
      } finally {
        await client.disconnect();
      }
    } catch (error) {
      if (
        !error.message.includes("TIMEOUT") &&
        !error.message.includes("CastError")
      ) {
        console.error(`Error: ${error.message}`.red);
      }
    }
  }

  async getQueryFromSession() {
    const sessions = glob.sync(`${this.sessionPath}/session_*.session`);
    for (const session of sessions) {
      const sessionFile = path.basename(session);
      await this.retrieveNewQueryData(sessionFile);
    }
  }

  async startBot() {
    this.isBotActive = true;
    this.lastActivityTime = new Date();
    await this.sendStaticUpdate();
  }

  async stopBot() {
    this.isBotActive = false;
    await this.sendStaticUpdate();
  }

  async updateActivity() {
    this.lastActivityTime = new Date();
    await this.sendStaticUpdate();
  }

  async updateStats(type, data) {
    switch (type) {
      case "account_update":
        this.stats.totalAccounts++;
        if (data.result === "Win") {
          this.stats.winsCount++;
          this.stats.totalProfit += data.balanceChange;
        } else {
          this.stats.lossesCount++;
          this.stats.totalProfit -= data.balanceChange;
        }
        break;
      case "daily_task":
        if (data.completed) {
          this.stats.dailyTasksCompleted++;
        }
        break;
      case "upgrade":
        this.stats.upgradesPerformed++;
        break;
      case "error":
        console.error(`Hata ${data.type}: ${data.message}`.red);
        break;
    }

    if (Date.now() - this.lastUpdateTime > this.updateInterval) {
      await this.sendStaticUpdate();
      this.lastUpdateTime = Date.now();
    }
  }

  async sendStaticUpdate() {
    const message = this.generateStaticMessage();
    if (this.telegramChatId) {
      if (this.telegramMessageId) {
        try {
          await bot.editMessageText(message, {
            chat_id: this.telegramChatId,
            message_id: this.telegramMessageId,
            parse_mode: "HTML",
            disable_notification: true,
          });
        } catch (error) {
          console.error("Mesaj düzenlenemedi:", error);
          await this.sendNewStaticMessage(message);
        }
      } else {
        await this.sendNewStaticMessage(message);
      }
    }
    console.log(message); // Log message to console
  }

  async sendNewStaticMessage(message) {
    try {
      const sentMessage = await bot.sendMessage(this.telegramChatId, message, {
        parse_mode: "HTML",
        disable_notification: true,
      });
      this.telegramMessageId = sentMessage.message_id;
    } catch (error) {
      console.error("Yeni mesaj gönderilemedi:", error);
    }
  }

  generateStaticMessage() {
    const statusEmoji = this.isBotActive ? "🟢" : "🔴";
    const winRate =
      this.stats.totalAccounts > 0
        ? ((this.stats.winsCount / this.stats.totalAccounts) * 100).toFixed(2)
        : 0;

    return `OKX Racer Bot Durum Güncellemesi

${statusEmoji} Bot Durumu: ${this.isBotActive ? "Active" : "Inactive"}
Last Activity: ${
      this.lastActivityTime
        ? this.lastActivityTime.toLocaleString()
        : "Son zamanlarda herhangi bir etkinlik yok"
    }

📊 Genel İstatistikler:
Toplam Bahis: ${this.stats.totalAccounts}
Kazançlar: ${this.stats.winsCount} | Kayıplar: ${this.stats.lossesCount}
Kazanma Oranı: ${winRate}%
Toplam Kar: ${this.stats.totalProfit} puan

🔄 Günlük Görevler Tamamlandı: ${this.stats.dailyTasksCompleted}`;
  }

  async main() {
    const dataFile = path.join(__dirname, "data.txt");
    let userData = fs
      .readFileSync(dataFile, "utf8")
      .replace(/\r/g, "")
      .split("\n")
      .filter(Boolean);

    bot.on("message", async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!AUTHORIZED_USERS.includes(userId)) {
        bot.sendMessage(
          chatId,
          "Yetkisiz erişim. Bu olay bildirilecek."
        );
        console.log(`Kullanıcı Kimliğinden yetkisiz erişim girişimi: ${userId}`);
        return;
      }

      if (msg.text.toLowerCase() === "/start") {
        this.telegramChatId = chatId;
        await this.startBot();
        bot.sendMessage(
          chatId,
          "OKX Racer Bot başladı. Güncellemeleri buradan alacaksınız."
        );
      } else if (msg.text.toLowerCase() === "/stop") {
        await this.stopBot();
        bot.sendMessage(
          chatId,
          "OKX Racer Bot durduruldu. Artık güncelleme almayacaksınız."
        );
        this.telegramChatId = null;
        this.telegramMessageId = null;
      } else if (msg.text.toLowerCase() === "/status") {
        await this.sendStaticUpdate();
      }
    });

    const nangcapfueltank = await this.askQuestion(
      "Yakıt Tankını yükseltmek ister misiniz??(y/n): "
    );
    const hoinangcap = nangcapfueltank.toLowerCase() === "y";
    const nangcapturbo = await this.askQuestion(
      "Turbo Charger'ı yükseltmek ister misiniz?(y/n): "
    );
    const hoiturbo = nangcapturbo.toLowerCase() === "y";

    const sessions = glob.sync(`${this.sessionPath}/session_*.session`);

    while (true) {
      if (this.isBotActive) {
        if (userData.length === 0) {
          console.log("Hiçbir sorgu bulunamadı, sorgular alınmaya çalışılıyor...");
          await this.getQueryFromSession();
          userData = fs
            .readFileSync(dataFile, "utf8")
            .replace(/\r/g, "")
            .split("\n")
            .filter(Boolean);
        }

        for (let i = 0; i < userData.length; i++) {
          const queryId = userData[i];
          const { extUserId, extUserName } = this.extractUserData(queryId);
          let sessionFile = path.basename(sessions[i % sessions.length]);

          try {
            console.log(
              `========== Hesap ${i + 1} | ${extUserName} ==========`.blue
            );
            await this.checkDailyRewards(extUserId, queryId);

            let boosts = await this.getBoosts(queryId);
            boosts.forEach((boost) => {
              console.log(
                `${boost.context.name.green}: ${boost.curStage}/${boost.totalStage}`
              );
            });

            let reloadFuelTank = boosts.find((boost) => boost.id === 1);
            let fuelTank = boosts.find((boost) => boost.id === 2);
            let turbo = boosts.find((boost) => boost.id === 3);

            if (fuelTank && hoinangcap) {
              const balanceResponse = await this.postToOKXAPI(
                extUserId,
                extUserName,
                queryId
              );
              const balancePoints = balanceResponse.data.data.balancePoints;
              if (
                fuelTank.curStage < fuelTank.totalStage &&
                balancePoints > fuelTank.pointCost
              ) {
                await this.upgradeFuelTank(queryId);
                boosts = await this.getBoosts(queryId);
                const updatedFuelTank = boosts.find((boost) => boost.id === 2);
                const updatebalanceResponse = await this.postToOKXAPI(
                  extUserId,
                  extUserName,
                  queryId
                );
                const updatedBalancePoints =
                  updatebalanceResponse.data.data.balancePoints;
                if (
                  updatedFuelTank.curStage >= fuelTank.totalStage ||
                  updatedBalancePoints < fuelTank.pointCost
                ) {
                  console.log("Yakıt Deposu yükseltmesi için uygun değilsiniz!".red);
                  continue;
                }
              } else {
                console.log("Yakıt Tankını yükseltmeye uygun değil!".red);
              }
            }

            if (turbo && hoiturbo) {
              const balanceResponse = await this.postToOKXAPI(
                extUserId,
                extUserName,
                queryId
              );
              const balancePoints = balanceResponse.data.data.balancePoints;
              if (
                turbo.curStage < turbo.totalStage &&
                balancePoints > turbo.pointCost
              ) {
                await this.upgradeTurbo(queryId);
                boosts = await this.getBoosts(queryId);
                const updatedTurbo = boosts.find((boost) => boost.id === 3);
                const updatebalanceResponse = await this.postToOKXAPI(
                  extUserId,
                  extUserName,
                  queryId
                );
                const updatedBalancePoints =
                  updatebalanceResponse.data.data.balancePoints;
                if (
                  updatedTurbo.curStage >= turbo.totalStage ||
                  updatedBalancePoints < turbo.pointCost
                ) {
                  console.log("Turbo Şarj Cihazının Yükseltilmesi Başarısız Oldu!".red);
                  continue;
                }
              } else {
                console.log("Turbo Şarj Cihazını yükseltmeye uygun değil!".red);
              }
            }

            while (true) {
              const price1 = await this.getCurrentPrice();
              await this.sleep(4000);
              const price2 = await this.getCurrentPrice();
              let predict;
              let action;
              if (price1 > price2) {
                predict = 0; // Sell
                action = "Sell";
              } else {
                predict = 1; // Buy
                action = "Buy";
              }
              const response = await this.postToOKXAPI(
                extUserId,
                extUserName,
                queryId
              );
              const balancePoints = response.data.data.balancePoints;
              console.log(`${"Denge Noktaları:".green} ${balancePoints}`);
              const assessResponse = await this.assessPrediction(
                extUserId,
                predict,
                queryId
              );
              const assessData = assessResponse.data.data;
              const result = assessData.won ? "Win".green : "Lose".red;
              const calculatedValue =
                assessData.basePoint * assessData.multiplier;
              console.log(
                `Tahmini ${action} | Sonuç: ${result} x ${assessData.multiplier}! Bakiye: ${assessData.balancePoints}, Almak: ${calculatedValue}, Eski fiyat: ${assessData.prevPrice}, Güncel fiyat: ${assessData.currentPrice}`
                  .magenta
              );

              await this.updateStats("account_update", {
                result: assessData.won ? "Win" : "Lose",
                balanceChange: calculatedValue,
              });

              if (assessData.numChance > 0) {
                await this.countdown(1);
              } else if (
                assessData.numChance <= 0 &&
                reloadFuelTank &&
                reloadFuelTank.curStage < reloadFuelTank.totalStage
              ) {
                await this.useBoost(queryId);
                boosts = await this.getBoosts(queryId);
                reloadFuelTank = boosts.find((boost) => boost.id === 1);
              } else {
                break;
              }
            }

            // Update activity after processing each account
            await this.updateActivity();
          } catch (error) {
            console.error(`${"Error:".red} ${error.message}`);
            userData.splice(i, 1);
            fs.writeFileSync(dataFile, userData.join("\n"));
            await this.replaceDeadQuery(sessionFile, i);
            const newData = fs
              .readFileSync(dataFile, "utf8")
              .replace(/\r/g, "")
              .split("\n")
              .filter(Boolean);
            userData = newData;
          }
        }

        await this.waitWithCountdown(5); // Wait for 5 minutes before the next cycle
      } else {
        await this.sleep(60000); // Sleep for 1 minute if bot is inactive
      }
    }
  }

  async askQuestion(query) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) =>
      rl.question(query, (ans) => {
        rl.close();
        resolve(ans);
      })
    );
  }

  async retryRequest(requestFunc, retries = this.retryCount) {
    for (let i = 0; i < retries; i++) {
      try {
        return await requestFunc();
      } catch (error) {
        if (i === retries - 1) {
          throw error;
        }
        console.log(
          `İstek hatayla başarısız oldu: ${error.message}. Tekrar deneniyor ${
            this.retryDelay / 1000
          } saniye...`
        );
        await this.sleep(this.retryDelay);
      }
    }
  }
}

// Start the process based on user input
if (require.main === module) {
  console.log(`
                     OKX Racer Script
                      Version: 1.0
                       Lose Online
        ==========================================
           Bu script OKX API ile etkileşimi otomatikleştirir ve durum raporu yalnızca yetkili kullanıcılara Telegram üzerinden gönderir.
        ==========================================
           Sorumlu bir şekilde kullanın.Bu kodun herhangi bir kötüye kullanımından sorumlu değilim.
        `);

  const okx = new OKX();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const menu = `
    Lütfen bir seçenek seçin:
    1. Oturum oluştur
    2. Oturumdan sorguyu al
    3. Yürüt
    `;
  console.log(menu);
  rl.question("Choose mode: ", async (option) => {
    rl.close();
    if (option === "1") {
      const phoneNumber = await okx.askQuestion(
        "Telefon numaranızı giriniz (+): "
      );
      const sessionName = await okx.askQuestion(
        "Bu oturum için bir ad girin (veya zaman damgası için boş bırakın)): "
      );
      await okx.createSession(phoneNumber, sessionName);
    } else if (option === "2") {
      await okx.getQueryFromSession();
    } else if (option === "3") {
      await okx.main();
    } else {
      console.error("Invalid option");
    }
  });
}
