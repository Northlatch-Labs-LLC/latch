# product/provider

Provider layer of the Latch overlay. This is where Latch binds to its model
gateway and billing endpoints.

- The gateway base URL and billing base URL come from
  `../identity/brand.yaml` (`gateway_base_url`, `billing_url`) and must not be
  hard-coded anywhere else.
- Provider configuration, request routing, and credential handling for the
  Latch distribution land here in later rounds.

This directory currently contains only this README; nothing in the upstream
runtime consumes it yet.
