const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Инициализация клиента Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Функция для генерации уникальной ссылки на WebApp
const generateReferralLink = (telegramId, totalCoins) =>
  `https://referal-testrer.netlify.app/?start=${telegramId}&totalCoins=${totalCoins}`;

// Функция для генерации ссылки на бота
const generateBotLink = (telegramId) =>
  `https://t.me/${process.env.BOT_USERNAME}?start=${telegramId}`;

// Обновление баланса пользователя и проверка бонусов рефералов
const updateUserBalance = async (telegramId, amount) => {
  try {
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('totalCoins, referrer_id')
      .eq('telegram_id', telegramId)
      .single();

    if (fetchError) throw new Error(`Error fetching user: ${fetchError.message}`);

    const newBalance = (user.totalCoins || 0) + amount;
    const { error: updateError } = await supabase
      .from('users')
      .update({ totalCoins: newBalance })
      .eq('telegram_id', telegramId);

    if (updateError) throw new Error(`Error updating balance: ${updateError.message}`);

    // Проверяем и начисляем бонусы рефереру
    if (user.referrer_id) {
      await checkReferralBonus(user.referrer_id);
    }
  } catch (error) {
    console.error('Error updating user balance:', error.message);
  }
};

// Функция для проверки баланса реферала и начисления бонусов рефереру
const checkReferralBonus = async (referrerId) => {
  try {
    // Получаем всех рефералов реферера
    const { data: referrals, error: fetchError } = await supabase
      .from('users')
      .select('telegram_id, totalCoins')
      .eq('referrer_id', referrerId);

    if (fetchError) throw new Error(`Error fetching referrals: ${fetchError.message}`);

    // Начисляем бонусы в зависимости от баланса рефералов
    for (const referral of referrals) {
      if (referral.totalCoins >= 50000) {
        await updateUserBalance(referrerId, 10000); // Начисляем 10000 totalCoins за реферала с 50000 totalCoins
      } else if (referral.totalCoins >= 25000) {
        await updateUserBalance(referrerId, 5000); // Начисляем 1000 totalCoins за реферала с 10000 totalCoins
      }
    }
  } catch (error) {
    console.error('Error checking referral bonus:', error.message);
  }
};


// Функция для получения баланса пользователя
const getUserBalance = async (telegramId) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('totalCoins')
      .eq('telegram_id', telegramId)
      .single();

    if (error) throw new Error(`Error fetching user balance: ${error.message}`);
    return user.totalCoins || 0;
  } catch (error) {
    console.error('Error fetching user balance:', error.message);
    return 0;
  }
};

// Функция для уведомления владельца ссылки с отображением имени пользователя
const notifyReferrer = async (referrerId, newUserId) => {
  try {
    // Получаем данные реферера
    const { data: referrer, error: fetchError } = await supabase
      .from('users')
      .select('chat_id')
      .eq('telegram_id', referrerId)
      .single();

    if (fetchError) throw new Error(`Error fetching referrer: ${fetchError.message}`);
    if (!referrer || !referrer.chat_id) return;

    // Получаем username нового пользователя
    const { data: newUser, error: newUserFetchError } = await supabase
      .from('users')
      .select('username')
      .eq('telegram_id', newUserId)
      .single();

    if (newUserFetchError) throw new Error(`Error fetching new user: ${newUserFetchError.message}`);

    const newUsername = newUser?.username || 'неизвестный пользователь';

    // Отправляем уведомление рефереру
    await bot.telegram.sendMessage(
      referrer.chat_id,
      `По вашей реферальной ссылке зарегистрировался новый пользователь: @${newUsername}`
    );
  } catch (error) {
    console.error('Error notifying referrer:', error.message);
  }
};

// Обработка команды /start
bot.start(async (ctx) => {
  const text = ctx.message.text;
  const parts = text.split(' ');
  const referrerId = parts[1] || null;
  const telegramId = ctx.from.id.toString();

  try {
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .limit(1);

    if (userError) throw new Error(`Error fetching user: ${userError.message}`);

    if (users.length === 0) {
      // Пользователь не зарегистрирован, добавляем его в базу данных
      await supabase.from('users').insert([
        {
          telegram_id: telegramId,
          referrer_id: referrerId,
          username: ctx.from.username || '', // Сохраняем username пользователя
          totalCoins: 0, // Инициализация баланса при регистрации
          chat_id: ctx.chat.id, // Сохраняем chat_id для уведомлений
          captcha_passed: false, // Добавляем поле для проверки капчи
        },
      ]);

      // Отправляем сообщение с кнопкой капчи
      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('Я не робот', 'CAPTCHA_PASSED'),
      ]);

      ctx.reply('Пожалуйста, подтвердите, что вы не робот, нажав на кнопку ниже.', keyboard);
    } else {
      ctx.reply('Вы уже зарегистрированы.');
    }
  } catch (error) {
    console.error('Error handling /start command:', error.message);
    ctx.reply('Произошла ошибка при обработке команды. Попробуйте позже.');
  }
});

// Обработка нажатия на кнопку капчи
bot.action('CAPTCHA_PASSED', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || 'пользователь'; // Получаем имя пользователя

  try {
    // Проверяем, прошел ли пользователь уже капчу
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('captcha_passed, referrer_id')
      .eq('telegram_id', telegramId)
      .single();

    if (fetchError) throw new Error(`Error fetching user: ${fetchError.message}`);
    if (!user) throw new Error('User not found');

    if (user.captcha_passed) {
      ctx.reply('Вы уже прошли капчу.');
      return;
    }

    // Отмечаем, что пользователь прошел капчу
    await supabase
      .from('users')
      .update({ captcha_passed: true })
      .eq('telegram_id', telegramId);

    // Начисляем бонус за успешное прохождение капчи
    await updateUserBalance(telegramId, 5000);

    // Получение текущего баланса пользователя
    const userBalance = await getUserBalance(telegramId);

    // Начисление бонуса рефереру, если есть
    if (user.referrer_id) {
      await updateUserBalance(user.referrer_id, 5000);
      await notifyReferrer(user.referrer_id, telegramId);
    }

    const referralLink = generateReferralLink(telegramId, userBalance); // Передача баланса в ссылке
    const botLink = generateBotLink(telegramId);

    // Отправляем сообщение с ссылками
    const keyboard = Markup.inlineKeyboard([
      Markup.button.webApp('👋Start Now!', referralLink),
      Markup.button.url('🔥Ref Link!', botLink),
    ]);

    ctx.reply(
      `Hello, @${username}! Welcome to COOKCOIN!
Click on - Start Now! And start earning coins\n\n` +
      `COOKCOIN - plans to list at the end of the whole story, I also advise you to look at the roadmap\n\n` +
      `Have friends, relatives, colleagues?\n` +
      `Bring them all into the game and unlock daily bonuses and the wheel of fortune\n` +
      `More friends, more coins.`,
      keyboard
    );
  } catch (error) {
    console.error('Error handling CAPTCHA action:', error.message);
    ctx.reply('Произошла ошибка при обработке капчи. Попробуйте позже.');
  }
});

// Обработка перехода по реферальной ссылке
bot.on('message', async (ctx) => {
  if (ctx.message.text.startsWith('/start')) {
    const text = ctx.message.text;
    const parts = text.split(' ');
    const referrerId = parts[1] || null;
    const telegramId = ctx.from.id.toString();

    try {
      if (referrerId) {
        // Проверяем, существует ли реферер
        const { data: referrer, error: fetchError } = await supabase
          .from('users')
          .select('telegram_id')
          .eq('telegram_id', referrerId)
          .single();

        if (fetchError) throw new Error(`Error fetching referrer: ${fetchError.message}`);
        if (!referrer) throw new Error('Referrer not found');

        // Уведомляем реферера
        await notifyReferrer(referrerId, telegramId);
      }
    } catch (error) {
      console.error('Error handling referral link:', error.message);
    }
  }
});

bot.launch();
console.log('Bot is running...');
