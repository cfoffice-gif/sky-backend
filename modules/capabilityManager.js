async function executePlan({ plan, context, capabilities }) {
  const results = [];

  for (const step of plan.steps || []) {
    const capability = capabilities[step.capability];

    if (!capability) {
      results.push({
        success: false,
        error: "Unknown capability: " + step.capability
      });
      continue;
    }

    const result = await capability.execute({
      step,
      context
    });

    results.push(result);
  }

  return {
    goal: plan.goal,
    results
  };
}

module.exports = {
  executePlan
};