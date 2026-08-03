---
name: ai_council
description: Trigger this skill when the user asks to run the "Conselho de IAs", "AI Council", or wants a complex task planned, developed, and reviewed by a council of AI agents.
---

# AI Council Skill

You are now equipped with a multi-agent system powered by Vertex AI. When the user invokes this skill (e.g. "Rode o Conselho de IAs para a tarefa X"), follow these exact steps:

1. Identify the task the user wants the council to perform.
2. Run the python script located at `.agents/skills/ai_council/scripts/ai_council.py` using your `run_command` tool. Pass the user's task description as the argument.
   Example: `$env:PYTHONIOENCODING="utf-8"; python .agents/skills/ai_council/scripts/ai_council.py "task description"`
3. Wait for the background task to complete.
4. The script will generate a file named `solucao_do_conselho.md` in the directory where it was executed.
5. Read the contents of `solucao_do_conselho.md`.
6. Present the final result (the code, architecture, and review) beautifully to the user in the chat, summarizing the council's findings. You can present it as an artifact or directly in the chat, highlighting the Architect, Developer, and Reviewer phases.

**Critical Notes:**
- The script uses Vertex AI Application Default Credentials, so it does not need any API Keys.
- Do NOT try to implement the code yourself. Your ONLY job is to execute the python script, wait for it to finish, and present the output from `solucao_do_conselho.md`.
