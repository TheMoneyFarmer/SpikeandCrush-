'use strict';

const sabotage = require('./sabotage');

const VARIANTS = ['standard', 'silver', 'gold'];
const VARIANT_PRICE = { standard: 0, silver: 150, gold: 400 }; // standard is the free default every player already owns

function buildCardVariantItems() {
  const items = [];
  for (const card of sabotage.getCardCatalog()) {
    for (const variant of VARIANTS) {
      if (variant === 'standard') continue; // owned by default, not purchasable
      items.push({
        id: `card_${card.id}_${variant}`,
        type: 'card_variant',
        name: `${card.name} (${variant[0].toUpperCase()}${variant.slice(1)})`,
        cardId: card.id,
        variant,
        price: VARIANT_PRICE[variant],
        icon: card.icon,
      });
    }
  }
  return items;
}

const AVATAR_FRAMES = [
  { id: 'frame_basic', type: 'avatar_frame', name: 'Basic Frame', price: 100 },
  { id: 'frame_teal_ring', type: 'avatar_frame', name: 'Animated Teal Ring', price: 200 },
  { id: 'frame_gold_sparkle', type: 'avatar_frame', name: 'Gold Sparkle', price: 400 },
  { id: 'frame_fire_ring', type: 'avatar_frame', name: 'Fire Ring', price: 600 },
  { id: 'frame_war_lord_crown', type: 'avatar_frame', name: 'War Lord Crown', price: 1000, requiresTier: 'War Lord' },
];

const PROFILE_BACKGROUNDS = [
  { id: 'bg_terminal_dark', type: 'profile_background', name: 'Trading Terminal Dark', price: 0 },
  { id: 'bg_neon_city', type: 'profile_background', name: 'Neon City', price: 200 },
  { id: 'bg_gold_rush', type: 'profile_background', name: 'Gold Rush', price: 300 },
  { id: 'bg_deep_space', type: 'profile_background', name: 'Deep Space', price: 400 },
  { id: 'bg_blood_red_market', type: 'profile_background', name: 'Blood Red Market', price: 500 },
];

const NAMEPLATE_EFFECTS = [
  { id: 'name_standard', type: 'nameplate', name: 'Standard', price: 0 },
  { id: 'name_flame', type: 'nameplate', name: 'Flame', price: 150 },
  { id: 'name_lightning', type: 'nameplate', name: 'Lightning', price: 200 },
  { id: 'name_matrix_rain', type: 'nameplate', name: 'Matrix Rain', price: 300 },
  { id: 'name_rainbow', type: 'nameplate', name: 'Rainbow', price: 250 },
];

function getCatalog() {
  return {
    cardVariants: buildCardVariantItems(),
    avatarFrames: AVATAR_FRAMES,
    profileBackgrounds: PROFILE_BACKGROUNDS,
    nameplateEffects: NAMEPLATE_EFFECTS,
  };
}

function findItem(itemId) {
  const catalog = getCatalog();
  const all = [...catalog.cardVariants, ...catalog.avatarFrames, ...catalog.profileBackgrounds, ...catalog.nameplateEffects];
  return all.find((i) => i.id === itemId) || null;
}

const SLOT_BY_TYPE = { avatar_frame: 'avatar_frame', profile_background: 'background', nameplate: 'nameplate' };

module.exports = { getCatalog, findItem, SLOT_BY_TYPE };
