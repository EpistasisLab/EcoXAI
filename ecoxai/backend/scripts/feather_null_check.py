"""
Pre-flight null-rate check for Feather files.

Usage:
    python feather_null_check.py <feather_path> [sample_rows]

Reads the first <sample_rows> rows (default 10000) using pyarrow's O(1) slice,
computes per-column null rates, classifies a missing_value_strategy, and emits
a single JSON line to stdout.

Exit codes:
    0  — success (including warnings / hard-stop result in JSON)
    1  — unrecoverable error (pyarrow missing, file unreadable)
"""

import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: feather_null_check.py <path> [sample_rows]"}),
              file=sys.stderr)
        sys.exit(1)

    feather_path = sys.argv[1]
    sample_rows = 10000
    if len(sys.argv) >= 3:
        try:
            sample_rows = int(sys.argv[2])
        except ValueError:
            pass

    try:
        import pyarrow.feather as feather
    except ImportError:
        print(json.dumps({"error": "pyarrow not installed"}), file=sys.stderr)
        sys.exit(1)

    try:
        table = feather.read_table(feather_path)
    except Exception as e:
        print(json.dumps({"error": f"Cannot read feather file: {e}"}), file=sys.stderr)
        sys.exit(1)

    num_rows = table.num_rows
    num_columns = table.num_columns
    actual_sample = min(sample_rows, num_rows)

    # O(1) slice — pyarrow returns a zero-copy view
    sample = table.slice(0, actual_sample)

    null_rates = {}
    for col_name in sample.schema.names:
        col = sample.column(col_name)
        null_count = col.null_count
        rate = null_count / actual_sample if actual_sample > 0 else 0.0
        null_rates[col_name] = round(rate, 6)

    quality_warnings = []

    # Classify missing_value_strategy
    corrupt_threshold = 0.90
    high_threshold = 0.50
    flag_threshold = 0.20

    cols_above_corrupt = [c for c, r in null_rates.items() if r >= corrupt_threshold]
    cols_above_high = [c for c, r in null_rates.items() if r > high_threshold]
    cols_above_flag = [c for c, r in null_rates.items() if r > flag_threshold]

    hard_stop = False

    if num_columns > 0 and len(cols_above_corrupt) == num_columns:
        strategy = "corrupt"
        reason = (
            f"All {num_columns} columns are ≥{int(corrupt_threshold*100)}% null "
            f"in first {actual_sample} rows — file appears corrupt or empty."
        )
        hard_stop = reason
    elif cols_above_high:
        strategy = "impute_or_drop"
        for col in cols_above_high:
            quality_warnings.append(
                f"Column '{col}' has {null_rates[col]:.1%} null rate (>{int(high_threshold*100)}%) — consider imputing or dropping."
            )
    elif cols_above_flag:
        strategy = "flag"
        for col in cols_above_flag:
            quality_warnings.append(
                f"Column '{col}' has {null_rates[col]:.1%} null rate (>{int(flag_threshold*100)}%) — flag for review."
            )
    else:
        strategy = "none"

    result = {
        "num_rows": num_rows,
        "num_columns": num_columns,
        "null_rates": null_rates,
        "missing_value_strategy": strategy,
        "quality_warnings": quality_warnings,
        "hard_stop": hard_stop,
        "sample_rows_checked": actual_sample,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
