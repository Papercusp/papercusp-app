"""Preserve the pinned ModernBERT RoPE contract across Transformers versions."""
import math
from numbers import Real


def apply_pinned_rope(config, snapshot_config):
    """Translate Transformers 5's attention-specific fields for older exporters.

    Transformers 4 accepts rope_parameters as an unused extra config attribute;
    its model still reads global_rope_theta/local_rope_theta. Load both spellings
    from the pinned bytes rather than accepting that runtime's local default.
    """
    if snapshot_config.get("model_type") != "modernbert":
        raise ValueError("mDenseOn export requires a pinned ModernBERT config")
    parameters = snapshot_config.get("rope_parameters")
    if not isinstance(parameters, dict):
        raise ValueError("pinned ModernBERT config is missing rope_parameters")
    values = {}
    for attention, legacy in (("full_attention", "global_rope_theta"),
                              ("sliding_attention", "local_rope_theta")):
        spec = parameters.get(attention)
        if not isinstance(spec, dict) or spec.get("rope_type") != "default":
            raise ValueError(f"unsupported pinned {attention} RoPE contract")
        theta = spec.get("rope_theta")
        if (isinstance(theta, bool) or not isinstance(theta, Real)
                or not math.isfinite(theta) or theta <= 0):
            raise ValueError(f"invalid pinned {attention} rope_theta")
        if legacy in snapshot_config and snapshot_config[legacy] != theta:
            raise ValueError(f"conflicting pinned {legacy} and rope_parameters")
        values[legacy] = float(theta)
    # Validate the entire contract before changing the loaded config.
    for name, theta in values.items():
        setattr(config, name, theta)
    config.rope_parameters = parameters
    return config
