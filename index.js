require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const {createClient} = require('redis');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const client = createClient(process.env.REDIS_URL);

client.on('error', (err) => console.error('Redis Client Error', err));
client.connect();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Delay function
const fetchWithRetry = async (url, options, retries = 5, delayMs = 5000) => {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios(url, options);
        return response;
      } catch (error) {
        if (error.response && error.response.status === 429) { // Rate limit exceeded
          const retryAfter = error.response.headers['retry-after'];
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delayMs;
          console.log(`Rate limit exceeded, retrying in ${waitTime}ms...`);
          await delay(waitTime);
        } else {
          throw error;
        }
      }
    }
    throw new Error("Max retries exceeded");
  };
  
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Define the escapeMarkdown function
const escapeMarkdown = (text) => {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
};

const formatHolders = (holders, mint) => {
  let position = 1;
  return holders
    .filter(holder => holder.tokens.some(token => token.token_address !== mint && token.total_price > 0))
    .map((holder) => {
      const shortAddress = `${holder.owner.slice(0, 4)}...${holder.owner.slice(-3)}`;
      const mainTokenValue = parseFloat(holder.token_value).toLocaleString();
      const mainTokenTicker = holder.token_ticker || 'tokens';
      const mainTokenPrice = holder.mainToken?.total_price || 0;
      
      let output = `H${position}: [${shortAddress}](https://solscan.io/account/${holder.owner})\n• Value: ${mainTokenValue} ${mainTokenTicker}`;
      if (mainTokenPrice > 0) {
        output += ` ($${mainTokenPrice.toLocaleString()})`;
      }
      
      const otherTokens = holder.tokens
        .filter(token => token.token_address !== mint && token.total_price > 0)
        .map(token => `• ${escapeMarkdown(token.token_name)}: $${token.total_price.toLocaleString()}`)
        .join('\n');
      
      if (otherTokens) {
        output += `\n${otherTokens}`;
      }
      position++;
      return output;
    })
    .join('\n\n');
};
  
const findHolders = async (mint) => {
  // Check cache
  const cachedData = await client.get(mint);
  if (cachedData) {
    console.log('Using cached data for', mint);
    await client.incr(`scan_count:${mint}`);
    return JSON.parse(cachedData);
  }

  console.log('Fetching new data for', mint);

  let page = 1;
  let allOwners = [];

  while (true) {
    const response = await fetchWithRetry(heliusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "getTokenAccounts",
        id: "helius-test",
        params: {
          page: page,
          limit: 1000,
          displayOptions: {},
          mint: mint,
        },
      }),
    });
    const data = response.data;
    if (!data.result || data.result.token_accounts.length === 0) {
      console.log(`No more results. Total pages: ${page - 1}`);
      break;
    }
    console.log(`Processing results from page ${page}`);
    data.result.token_accounts.forEach((account) => {
      if (account.owner !== "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1") {
        const tokenValue = (account.amount / 1e6).toFixed(2); // Assuming token has 6 decimals
        allOwners.push({ owner: account.owner, amount: account.amount, token_value: tokenValue });
      }
    });
    page++;
  }

  allOwners.sort((a, b) => b.amount - a.amount);
  const topOwners = allOwners.slice(0, 20);

  for (const owner of topOwners) {
    await delay(500); // Add a delay of 500ms between requests
    const response = await fetchWithRetry(heliusUrl, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json"
      },
      data: JSON.stringify({
        "jsonrpc": "2.0",
        "id": "text",
        "method": "searchAssets",
        "params": {
          "ownerAddress": owner.owner,
          "tokenType": "fungible"
        }
      }),
    });

    const data = response.data;

    if (data.result && Array.isArray(data.result.items)) {
      owner.tokens = data.result.items
        .filter(token => token.content && token.content.metadata)
        .map(token => {
          const tokenInfo = token.token_info || {};
          const priceInfo = tokenInfo.price_info || {};
          const balance = tokenInfo.balance || 0;
          const decimals = tokenInfo.decimals || 0;
          const pricePerToken = priceInfo.price_per_token || 0;
          const totalPrice = (balance / Math.pow(10, decimals)) * pricePerToken;
          return {
            token_name: token.content.metadata.name || "Unknown",
            token_symbol: token.content.metadata.symbol || "Unknown",
            token_address: token.id,
            total_price: totalPrice,
            balance: balance,
            decimals: decimals,
            price_per_token: pricePerToken
          };
        })
        .sort((a, b) => b.total_price - a.total_price);

      // Store the main token separately
      owner.mainToken = owner.tokens.find(token => token.token_address === mint);
      if (owner.mainToken) {
        owner.token_value = (owner.mainToken.balance / Math.pow(10, owner.mainToken.decimals)).toFixed(2);
        owner.token_ticker = owner.mainToken.token_symbol;
      }

      // Keep top 3 tokens including the main token
      owner.tokens = owner.tokens
        .filter(token => token.total_price >= 1000)
        .slice(0, 3);
    } else {
      console.log(`Unexpected result format for owner: ${owner.owner}`, data);
      owner.tokens = [];
    }
  }

  const filteredOwners = topOwners.filter(owner => 
    owner.mainToken && 
    parseFloat(owner.token_value) > 1000 &&
    owner.tokens.some(token => token.token_address !== mint && token.total_price > 0)
  );

  const numberOfWhales = filteredOwners.length;
  const totalWorth = filteredOwners.reduce((acc, owner) => {
    const tokenTotalValue = owner.tokens.reduce((sum, token) => sum + token.total_price, 0);
    return acc + tokenTotalValue;
  }, 0).toFixed(2);

  // Get the token symbol and name for the scanned token
  const scannedToken = filteredOwners[0]?.mainToken;
  const scannedTokenSymbol = scannedToken?.token_symbol || 'Unknown';
  const scannedTokenName = scannedToken?.token_name || 'Unknown Token';

  // Calculate top 3 other tokens by total dollar value
  const tokenValues = {};
  filteredOwners.forEach(owner => {
    owner.tokens.forEach(token => {
      if (token.token_address !== mint) {
        if (!tokenValues[token.token_name]) {
          tokenValues[token.token_name] = {
            total_value: 0,
            token_address: token.token_address
          };
        }
        tokenValues[token.token_name].total_value += token.total_price;
      }
    });
  });

  const top4Tokens = Object.entries(tokenValues)
    .sort((a, b) => b[1].total_value - a[1].total_value)
    .slice(0, 4)
    .map(([tokenName, data]) => 
      `[${tokenName}](https://solscan.io/token/${data.token_address}) ($${data.total_value.toLocaleString()})`
    );

  // Remove the scanned token from the top tokens if it's present
  const top3Tokens = top4Tokens.filter(token => !token.includes(mint)).slice(0, 3).join(", ");

  const result = {
    filteredOwners,
    numberOfWhales,
    totalWorth,
    top3Tokens,
    scannedTokenSymbol,
    scannedTokenName
  };

  // Store result in cache
  await client.set(mint, JSON.stringify(result), 'EX', 3600); // Cache for 1 hour
  await client.incr(`scan_count:${mint}`);

  return result;
};

const MAX_MESSAGE_LENGTH = 4096; // Telegram max message length

const splitMessage = (message, maxLength = MAX_MESSAGE_LENGTH) => {
  const parts = [];
  let remainingMessage = message;

  while (remainingMessage.length > maxLength) {
    let part = remainingMessage.slice(0, maxLength);

    const lastNewLineIndex = part.lastIndexOf('\n');
    if (lastNewLineIndex > -1) {
      part = remainingMessage.slice(0, lastNewLineIndex);
    }

    parts.push(part);
    remainingMessage = remainingMessage.slice(part.length).trim();
  }

  parts.push(remainingMessage);
  return parts;
};

// New function to get usage statistics
const getUsageStats = async () => {
  const scanKeys = await client.keys('scan_count:*');
  const totalScans = await scanKeys.reduce(async (accPromise, key) => {
    const acc = await accPromise;
    const count = await client.get(key);
    return acc + parseInt(count);
  }, Promise.resolve(0));

  const uniqueTokens = scanKeys.length;
  
  let mostScannedToken = '';
  let maxScans = 0;
  for (const key of scanKeys) {
    const count = await client.get(key);
    if (parseInt(count) > maxScans) {
      maxScans = parseInt(count);
      mostScannedToken = key.replace('scan_count:', '');
    }
  }

  // Get unique users
  const userKeys = await client.keys('user:*');
  const uniqueUsers = userKeys.length;

  // Get token info for the most scanned token
  let tokenSymbol = 'Unknown';
  let tokenName = 'Unknown Token';
  if (mostScannedToken) {
    const tokenData = await client.get(mostScannedToken);
    if (tokenData) {
      const parsedData = JSON.parse(tokenData);
      tokenSymbol = parsedData.scannedTokenSymbol || 'Unknown';
      tokenName = parsedData.scannedTokenName || 'Unknown Token';
    }
  }

  return {
    totalScans,
    uniqueTokens,
    uniqueUsers,
    mostScannedToken,
    maxScans,
    tokenSymbol,
    tokenName
  };
};

// New function to clear cache for a specific token
const clearCache = async (mint) => {
  await client.del(mint);
  await client.del(`scan_count:${mint}`);
};

// New function to check if cache needs update
const isCacheStale = async (mint) => {
  const cacheTime = await client.ttl(mint);
  return cacheTime < 0 || cacheTime < 1800; // Consider cache stale if less than 30 minutes left
};

// Add this near the top of your file, with other environment variable imports
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

// Add this function to check if a user is an admin
const isAdmin = (userId) => {
  return userId.toString() === ADMIN_USER_ID;
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const keyboard = [
    [{ text: '/snapshot' }],
    [{ text: '/help' }]
  ];

  if (isAdmin(userId)) {
    keyboard.push([{ text: '/stats' }]);
  }

  const opts = {
    reply_markup: {
      keyboard: keyboard,
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };

  bot.sendMessage(chatId, 'Welcome! Use /snapshot to get started or /help for more information.', opts);
});

bot.onText(/\/snapshot(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  let contractAddress = match[1] ? match[1].trim() : null;

  if (!contractAddress) {
    bot.sendMessage(chatId, 'Please paste the contract address:');
    bot.once('message', async (msg) => {
      contractAddress = msg.text.trim();
      await fetchSnapshot(chatId, contractAddress);
    });
  } else {
    await fetchSnapshot(chatId, contractAddress);
  }
});

const fetchSnapshot = async (chatId, contractAddress) => {
  bot.sendMessage(chatId, `Fetching holder snapshot for contract address: ${contractAddress}`);
  
  try {
    console.log('Fetching data for', contractAddress);
    const { filteredOwners, numberOfWhales, totalWorth, top3Tokens, scannedTokenSymbol, scannedTokenName } = await findHolders(contractAddress);
    console.log('Data fetched for', contractAddress);

    const scanCount = await client.get(`scan_count:${contractAddress}`);
    const summary = `Summary for [${scannedTokenSymbol}](https://solscan.io/token/${contractAddress}):\nNumber of whales: ${numberOfWhales}\nTop 3 other tokens: ${top3Tokens}\nTotal worth: $${parseFloat(totalWorth).toLocaleString()}\nScanned: ${scanCount} times`;
    await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', disable_web_page_preview: true });
    
    // Track unique user
    await client.set(`user:${chatId}`, '1', 'EX', 30 * 24 * 60 * 60); // Store for 30 days

    if (filteredOwners.length > 0) {
      const formattedHolders = formatHolders(filteredOwners, contractAddress);
      const messages = splitMessage(`Top 20 Holders of ${scannedTokenName} (${scannedTokenSymbol}):\n\n${formattedHolders}`);
      for (const message of messages) {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
    } else {
      await bot.sendMessage(chatId, "No qualifying holders found.");
    }
  } catch (error) {
    console.error('Error in fetchSnapshot:', error);
    if (error instanceof AggregateError) {
      bot.sendMessage(chatId, `Failed to fetch holder snapshot: Multiple errors occurred. Please try again later.`);
    } else {
      bot.sendMessage(chatId, `Failed to fetch holder snapshot: ${error.message}`);
    }
  }
};

// Modify the /stats command handler
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, "Sorry, this command is only available to admins.");
    return;
  }

  const stats = await getUsageStats();
  const message = `Bot Usage Statistics:
Total scans: ${stats.totalScans}
Unique tokens scanned: ${stats.uniqueTokens}
Unique users: ${stats.uniqueUsers}
Most scanned token: [${stats.tokenSymbol}](https://solscan.io/token/${stats.mostScannedToken}) (${stats.maxScans} times)`;
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// You might want to do the same for the /clearcache command
bot.onText(/\/clearcache (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, "Sorry, this command is only available to admins.");
    return;
  }

  const mint = match[1];
  await clearCache(mint);
  bot.sendMessage(chatId, `Cache cleared for token: ${mint}`);
});

// Modify the /help command to show admin commands only to admins
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  let helpMessage = `Available commands:
/snapshot <contract_address> - Get a snapshot of token holders
/help - Show this help message`;

  if (isAdmin(userId)) {
    helpMessage += `\n\nAdmin commands:
/stats - View bot usage statistics
/clearcache <contract_address> - Clear cache for a specific token`;
  }

  bot.sendMessage(chatId, helpMessage);
});

