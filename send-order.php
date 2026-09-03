<?php
/**
 * send-order.php
 * Telegram ဆီကို message ပို့ပေးမယ့် Backend Proxy
 * BOT_TOKEN နှင့် CHAT_ID ကို ဒီဖိုင်ထဲမှာသာ သိမ်းထားပြီး
 * Browser (client) ဘက်ကို ဘယ်တော့မှ ပို့မထားပါ။
 */

// ---- ဒီနေရာမှာသာ Token ကို ထည့်ပါ (client ဆီ ဘယ်လိုမှ မပေါ်ပါ) ----
define('BOT_TOKEN', '8215695761:AAF1qDjAJn7gjiHyzf8t7W6c8e51cim98sU');
define('CHAT_ID', '8116152317');
// -------------------------------------------------------------

header('Content-Type: application/json; charset=utf-8');

// POST method ကနေသာ ခွင့်ပြုမယ်
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

// Optional: သင့်ရဲ့ domain ကနေပဲ ခေါ်ခွင့်ပြုချင်ရင် ဒီနေရာမှာ
// origin check ထည့်နိုင်ပါတယ် (မဖြစ်မနေ မလိုအပ်ပေမယ့် ထားပေးထားပါတယ်)
// $allowedOrigin = 'https://yourdomain.com';
// if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $allowedOrigin) {
//     http_response_code(403);
//     echo json_encode(['ok' => false, 'error' => 'Forbidden']);
//     exit;
// }

// Browser ကနေ ပို့လိုက်တဲ့ JSON ကို ဖတ်မယ်
$input = json_decode(file_get_contents('php://input'), true);

if (!$input || empty($input['text'])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Missing message text']);
    exit;
}

// text field ကိုပဲ လက်ခံမယ် (ဒီအောက်က field တွေကိုပဲ တင်းတင်းကျပ်ကျပ် သတ်မှတ်)
$text = (string) $input['text'];

// Telegram API ကို server-side ကနေ ခေါ်မယ်
$telegramUrl = 'https://api.telegram.org/bot' . BOT_TOKEN . '/sendMessage';

$payload = json_encode([
    'chat_id'    => CHAT_ID,
    'text'       => $text,
    'parse_mode' => 'Markdown',
]);

$ch = curl_init($telegramUrl);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 15,
]);

$response  = curl_exec($ch);
$httpCode  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Telegram request failed', 'detail' => $curlError]);
    exit;
}

http_response_code($httpCode ?: 200);
echo $response; // Telegram ရဲ့ response ကိုတိုက်ရိုက် ပြန်ပို့ပေးမယ်
