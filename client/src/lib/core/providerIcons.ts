export const providerIcons = {
	claude: 'Claude',
	codex: 'Codex',
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	deepseek: 'DeepSeek',
	gemini: 'Gemini',
	grok: 'Grok / xAI',
	qwen: 'Qwen',
	mistral: 'Mistral',
	meta: 'Meta / Llama',
	ollama: 'Ollama',
	openrouter: 'OpenRouter',
	perplexity: 'Perplexity',
	cohere: 'Cohere',
	copilot: 'GitHub Copilot',
	moonshot: 'Moonshot / Kimi'
} as const;
export type ProviderIcon = keyof typeof providerIcons;
export type ProviderIconChoice = ProviderIcon | 'auto' | 'none';
export function readProviderIcon(value: unknown): ProviderIconChoice {
	return typeof value === 'string' && (value === 'none' || Object.hasOwn(providerIcons, value))
		? (value as ProviderIconChoice)
		: 'auto';
}
export function resolveProviderIcon(provider: {
	icon?: ProviderIconChoice;
	source: string;
	label: string;
	account: string;
}): ProviderIcon | undefined {
	if (provider.icon === 'none') return undefined;
	if (provider.icon && provider.icon !== 'auto') return provider.icon;
	if (Object.hasOwn(providerIcons, provider.source)) return provider.source as ProviderIcon;
	const words = `${provider.label} ${provider.account}`.toLowerCase().split(/[^a-z0-9]+/);
	const aliases: Record<string, ProviderIcon> = {
		oai: 'openai',
		ds: 'deepseek',
		xai: 'grok',
		llama: 'meta',
		kimi: 'moonshot',
		google: 'gemini'
	};
	for (const word of words) {
		if (Object.hasOwn(providerIcons, word)) return word as ProviderIcon;
		if (Object.hasOwn(aliases, word)) return aliases[word];
	}
	return undefined;
}
