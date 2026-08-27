'use strict';

/**
 * server/lib/plans.js — plan adlarının tek doğruluk kaynağı.
 *
 * 'multi' eski "Multi-Profile" paketinin adı. Ultimate onun yerini aldı ama
 * eski aboneler hâlâ 'multi' taşıyor, bu yüzden ikisi de geçerli kalıyor.
 */

const ALL_PLANS           = ['free', 'pro', 'multi', 'ultimate'];
const PAID_PLANS          = ['pro', 'multi', 'ultimate'];
const MULTI_PROFILE_PLANS = ['multi', 'ultimate'];

module.exports = { ALL_PLANS, PAID_PLANS, MULTI_PROFILE_PLANS };
