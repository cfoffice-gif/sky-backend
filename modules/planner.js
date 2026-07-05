async function plan({ askOpenAI, systemPrompt, currentUser, task }) {

    const reply = await askOpenAI(
        systemPrompt,
`
You are Sky's planning engine.

Your job is NOT to answer the user.

Your job is to understand the user's objective.

Return JSON ONLY.

Current user:

${JSON.stringify(currentUser,null,2)}

Request:

${task}

Return this format exactly:

{
  "goal":"...",
  "capabilities":[
      "tasks"
  ],
  "steps":[
      {
         "capability":"tasks",
         "action":"create"
      }
  ]
}
`
    );

    try{
        return JSON.parse(reply);
    }
    catch(err){

        console.error(reply);

        return{

            goal:"Fallback",

            capabilities:["chat"],

            steps:[
                {
                    capability:"chat",
                    action:"reply"
                }
            ]

        };

    }

}

module.exports = {
    plan
};