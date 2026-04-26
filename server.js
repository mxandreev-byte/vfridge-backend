/**
 * Виртуальный холодильник — backend
 *
 * Простой прокси-сервис между PWA и GigaChat API.
 * Скрывает API-ключ от клиента и кэширует токены.
 *
 * Endpoints:
 *   POST /api/chef-suggest  — сгенерировать рецепт из списка продуктов
 *   GET  /health           — health check
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// === CORS ===
// Разрешаем запросы с нашего домена + локальный dev
const ALLOWED_ORIGINS = [
  'https://v-fridge.ru',
  'http://v-fridge.ru',
  'https://www.v-fridge.ru',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
  'null', // file:// для локального тестирования
];

// Расширенная конфигурация CORS — критично для iOS Safari
app.use(cors({
  origin: (origin, callback) => {
    // Разрешаем без origin (curl, Postman, нативные приложения) и из whitelist
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('CORS allowed (with warning):', origin);
      callback(null, true); // Пока не блокируем для тестов
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
  credentials: false,
  maxAge: 86400, // кэш preflight на 24 часа
  optionsSuccessStatus: 200, // Safari иногда не понимает 204
}));

// Явный обработчик OPTIONS (preflight) — iOS Safari иногда падает без него
app.options('*', cors());

app.use(express.json({ limit: '10kb' }));

// === Простой rate limit (in-memory) ===
// Защита от спама — 30 запросов в минуту с одного IP
const rateLimits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 30;

  const record = rateLimits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count++;
  rateLimits.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  }
  next();
}

// === GigaChat: получение access token ===
// Токен живёт 30 минут — кэшируем его
let cachedToken = { value: null, expiresAt: 0 };

async function getGigaChatToken() {
  // Если токен ещё свежий (с запасом 1 минута) — отдаём кэш
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const authKey = process.env.GIGACHAT_AUTH_KEY;
  if (!authKey) {
    throw new Error('GIGACHAT_AUTH_KEY не настроен в env');
  }

  const requestId = crypto.randomUUID();
  const body = 'scope=GIGACHAT_API_PERS';

  const result = await fetchJson('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'RqUID': requestId,
      'Authorization': `Basic ${authKey}`,
    },
    body,
  });

  if (!result.access_token) {
    throw new Error('Не удалось получить токен GigaChat: ' + JSON.stringify(result));
  }

  cachedToken = {
    value: result.access_token,
    expiresAt: result.expires_at, // unix timestamp в миллисекундах
  };
  return cachedToken.value;
}

// === GigaChat: запрос на генерацию рецепта ===
async function generateRecipe(productNames, mode = 'auto') {
  const token = await getGigaChatToken();

  // Определяем роль и инструкции в зависимости от mode
  // 'auto'  — модель сама решает (по умолчанию)
  // 'food'  — только блюдо
  // 'drink' — только напиток / коктейль
  let roleIntro, contextHint;

  if (mode === 'drink') {
    roleIntro = 'Ты — опытный бармен. Тебе дают список продуктов и напитков из холодильника пользователя — ты должен предложить ОДИН конкретный напиток или коктейль, который можно из них приготовить.';
    contextHint = 'Это должен быть НАПИТОК (коктейль, лимонад, смузи, морс, мокктейль и т.п.), а не блюдо.';
  } else if (mode === 'food') {
    roleIntro = 'Ты — опытный шеф-повар. Тебе дают список продуктов из холодильника пользователя — ты должен предложить ОДНО конкретное блюдо, которое можно из них приготовить.';
    contextHint = 'Это должно быть БЛЮДО (горячее, салат, закуска, десерт), а не напиток.';
  } else {
    // auto — самый интересный режим
    roleIntro = 'Ты — опытный шеф-повар И бармен в одном лице. Тебе дают список продуктов из холодильника — ты должен предложить ОДНО конкретное блюдо ИЛИ напиток (что больше подходит к набору продуктов).';
    contextHint = 'Подумай, что лучше получится из этих продуктов: блюдо или напиток. Если есть алкоголь, соки, газировка, сиропы и фрукты — скорее всего, человек хочет коктейль или лимонад. Если есть мясо, овощи, крупы — хочет полноценное блюдо. Принимай решение сам.';
  }

  const systemPrompt = `${roleIntro}

КОНТЕКСТ: ${contextHint}

ПРАВИЛА:
1. Используй ТОЛЬКО продукты из списка + базовые специи и добавки (соль, перец, растительное масло, вода, лёд) — больше ничего предлагать нельзя.
2. Результат должен быть СЪЕДОБНЫМ/ВКУСНЫМ и ЛОГИЧНЫМ — никакой кулинарной или барной ереси.
3. Если из этих продуктов невозможно приготовить осмысленный рецепт — честно скажи об этом в поле "name", напиши: "Невозможно приготовить".
4. Время — реалистичное (для напитков 2-15 минут, для блюд 10-90 минут).
5. Калории — приблизительная оценка на 1 порцию.
6. Шаги — простые, понятные, 3-7 пунктов.

ВАЖНО: В поле "type" укажи "drink" если это напиток (коктейль, лимонад, смузи, морс) или "food" если это блюдо.

ОТВЕТ ВЫДАЙ СТРОГО В ФОРМАТЕ JSON, без markdown-блока, без пояснений до или после JSON. Только сам JSON. Структура:
{
  "name": "Название",
  "type": "food" | "drink",
  "icon": "одно подходящее эмодзи",
  "time": число_минут,
  "servings": число_порций,
  "calories": калории_на_порцию,
  "difficulty": "easy" | "medium" | "hard",
  "cuisine": "название кухни",
  "description": "одно предложение что это за рецепт и почему он подходит",
  "used": ["список", "использованных", "продуктов"],
  "steps": ["шаг 1", "шаг 2", "..."]
}`;

  const userPrompt = `У меня есть: ${productNames.join(', ')}.

Что ${mode === 'drink' ? 'выпить' : (mode === 'food' ? 'приготовить' : 'из этого получится')}?`;

  const requestBody = {
    model: 'GigaChat-2', // Lite (бесплатный лимит 900K токенов)
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 800,
  };

  const response = await fetchJson('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.choices || !response.choices[0]) {
    throw new Error('Некорректный ответ GigaChat: ' + JSON.stringify(response));
  }

  const text = response.choices[0].message.content.trim();

  // Парсим JSON из ответа модели (на всякий случай чистим markdown)
  let json;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    json = JSON.parse(cleaned);
  } catch (e) {
    console.error('Не удалось распарсить ответ GigaChat:', text);
    throw new Error('Модель вернула некорректный JSON');
  }

  return {
    ...json,
    isAiGenerated: true,
  };
}

// === Обёртка над fetch с поддержкой Node.js < 18 ===
// В Node 18+ fetch встроен, но для надёжности и SSL-настроек используем https напрямую для ngw
function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      // GigaChat использует российский корневой сертификат — отключаем строгую проверку для простоты деплоя
      rejectUnauthorized: false,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Не JSON в ответе: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса')));
    req.setTimeout(30_000);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// === ENDPOINTS ===

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasToken: !!cachedToken.value,
    tokenExpiresIn: cachedToken.value ? Math.max(0, Math.floor((cachedToken.expiresAt - Date.now()) / 1000)) : 0,
  });
});

app.post('/api/chef-suggest', rateLimit, async (req, res) => {
  try {
    const { products, mode } = req.body;
    // mode может быть 'auto' (по умолчанию), 'food' или 'drink'
    const validMode = ['auto', 'food', 'drink'].includes(mode) ? mode : 'auto';

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Передайте список продуктов в поле "products"' });
    }
    if (products.length > 50) {
      return res.status(400).json({ error: 'Слишком много продуктов (макс 50)' });
    }
    // Фильтруем явный мусор
    const cleanProducts = products
      .filter((p) => typeof p === 'string' && p.trim().length > 0 && p.length < 50)
      .map((p) => p.trim().slice(0, 50));

    if (cleanProducts.length === 0) {
      return res.status(400).json({ error: 'Список продуктов пуст' });
    }

    console.log(`[chef-suggest] products: ${cleanProducts.join(', ')}, mode: ${validMode}`);
    const recipe = await generateRecipe(cleanProducts, validMode);
    console.log(`[chef-suggest] result: ${recipe.name} (${recipe.type || 'food'})`);

    res.json({ recipe });
  } catch (error) {
    console.error('[chef-suggest] error:', error.message);
    res.status(500).json({
      error: 'Не удалось сгенерировать рецепт. Попробуйте ещё раз.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// === Запуск ===
app.listen(PORT, () => {
  console.log(`🌿 Virtual Fridge backend запущен на порту ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   GigaChat key: ${process.env.GIGACHAT_AUTH_KEY ? 'настроен ✓' : 'НЕ НАСТРОЕН ✗'}`);
});
