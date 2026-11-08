---
slug: leverage
title: "Leverage and margin"
category: rules
tags: ["leverage", "margin", "margin call"]
source: code
needs_review: true
---

# Leverage and margin

The game does not use a leverage setting. Position size is controlled by lot size (up to 10 lots per trade) and risk is capped by the loss limits: a 20% loss within 2 minutes pauses new trades, and a 50% total loss ends your trading for the match.

If you need a specific leverage figure, a human agent can confirm it. (Marked for review: the Help page talks about leverage and margin calls in general terms, but no leverage value exists in the game code.)
