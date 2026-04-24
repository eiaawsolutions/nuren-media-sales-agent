import { Router } from 'express';
import { answerAssistantQuestion } from '../services/assistant-chat.js';

const router = Router();

/**
 * POST /api/assistant/chat
 * Body: { question: string, brand?: string }
 * Response: { answer: string, citations: [...], model: string }
 *
 * Rate-limited by the parent /api limiter (180 req/min) so no additional
 * per-route limiter needed. Errors bubble as 500 with a clean message; the
 * underlying Anthropic client is shared with the rest of the app so credit
 * depletion surfaces the same way as the other AI features.
 */
router.post('/chat', async (req, res) => {
  try {
    const question = req.body?.question;
    const brand = req.body?.brand || null;
    const result = await answerAssistantQuestion({
      userId: req.user.id,
      question,
      brand,
    });
    res.json(result);
  } catch (err) {
    console.error('[assistant/chat]', err.message);
    const status = /credit balance/i.test(err.message) ? 402
      : /invalid api key|authentication/i.test(err.message) ? 401
      : /rate.?limit/i.test(err.message) ? 429
      : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
