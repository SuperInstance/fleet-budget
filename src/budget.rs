use serde::{Deserialize, Serialize};

/// Budget allocation for a fleet segment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetAllocation {
    pub segment: String,
    pub limit_cents: u64,
    pub used_cents: u64,
}

impl BudgetAllocation {
    pub fn remaining(&self) -> u64 {
        self.limit_cents.saturating_sub(self.used_cents)
    }

    pub fn utilization(&self) -> f64 {
        if self.limit_cents == 0 {
            0.0
        } else {
            self.used_cents as f64 / self.limit_cents as f64
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_budget() {
        let b = BudgetAllocation {
            segment: "compute".into(),
            limit_cents: 10000,
            used_cents: 3500,
        };
        assert_eq!(b.remaining(), 6500);
        assert!((b.utilization() - 0.35).abs() < 0.001);
    }
}
