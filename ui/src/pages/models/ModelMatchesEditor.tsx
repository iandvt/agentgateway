import { Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { type Control, Controller, type UseFormSetValue, useFieldArray } from 'react-hook-form';

import { Tooltip } from '@/components/Primitives';
import type { ModelForm } from '@/pages/Models';
import { CollapsiblePolicySection } from '@/policies/PolicyLayout';
import type { LlmModel } from '@/types';

type ModelMatch = NonNullable<LlmModel['matches']>[number];
type HeaderMatch = NonNullable<ModelMatch['headers']>[number];

// Matches are rows of `matchRows` (their position is the match index). Header
// rows are one flat list, and each header's `owner` is the index of its match.
// Removing a match rewrites the owners after it with primitive leaves, then
// removes rows, so the other rows keep their field ids. Saved values never
// contain `owner`.
export type MatchesFormValues = {
	matchRows: Array<Omit<ModelMatch, 'headers'>>;
	matchHeaders: Array<HeaderMatch & { owner: number }>;
};

export function splitModelMatches(matches: ModelMatch[] | null | undefined): MatchesFormValues {
	const list = matches ?? [];
	return {
		matchRows: list.map(({ headers: _headers, ...row }) => row),
		matchHeaders: list.flatMap((match, owner) =>
			(match.headers ?? []).map(header => ({ owner, ...header }))
		)
	};
}

// Saved matches from the form rows. A match without headers stays in the list
// here, and normalizeMatches drops it at save time.
export function buildModelMatches({ matchRows, matchHeaders }: MatchesFormValues): ModelMatch[] {
	return matchRows.map((row, owner) => ({
		...row,
		headers: matchHeaders
			.filter(header => header.owner === owner)
			.map(({ owner: _owner, ...header }) => header)
	}));
}

// The field arrays are read from their own fields: an owner changes only in
// removeMatch, which is followed by an array action that refreshes them.
export function ModelMatchesEditor(props: {
	control: Control<ModelForm>;
	setValue: UseFormSetValue<ModelForm>;
}) {
	const matchRows = useFieldArray({ control: props.control, name: 'matchRows' });
	const matchHeaders = useFieldArray({ control: props.control, name: 'matchHeaders' });

	function addMatch() {
		const owner = matchRows.fields.length;
		matchRows.append({});
		matchHeaders.append({ owner, name: '', value: { exact: '' } });
	}

	function removeMatch(index: number) {
		const owned: number[] = [];
		matchHeaders.fields.forEach((header, position) => {
			if (header.owner === index) owned.push(position);
			if (header.owner > index) props.setValue(`matchHeaders.${position}.owner`, header.owner - 1);
		});
		matchHeaders.remove(owned);
		matchRows.remove(index);
	}

	// A match's headers are contiguous, so a new one goes after the last header
	// of every match up to and including `index`.
	function addHeader(index: number) {
		const position = matchHeaders.fields.filter(header => header.owner <= index).length;
		matchHeaders.insert(position, { owner: index, name: '', value: { exact: '' } });
	}

	return (
		<CollapsiblePolicySection
			icon={<SlidersHorizontal size={17} />}
			title="Matches"
			description="At least one match group must match. Within a group, every header condition must match."
			defaultOpen={matchRows.fields.length > 0}
		>
			{matchRows.fields.length ? (
				<div className="policy-editor-stack compact">
					{matchRows.fields.map((field, index) => (
						<MatchCard
							key={field.id}
							control={props.control}
							index={index}
							headers={matchHeaders.fields.flatMap((header, position) =>
								header.owner === index ? [{ id: header.id, position }] : []
							)}
							onAddHeader={() => addHeader(index)}
							onRemove={() => removeMatch(index)}
							onRemoveHeader={position => matchHeaders.remove(position)}
						/>
					))}
				</div>
			) : (
				<div className="empty-inline">No additional match conditions.</div>
			)}
			<div className="button-row">
				<button className="button" type="button" onClick={addMatch}>
					<Plus size={16} />
					Add match
				</button>
			</div>
		</CollapsiblePolicySection>
	);
}

export function normalizeMatches(matches: LlmModel['matches'] | null | undefined) {
	const next = (matches ?? [])
		.map(match => ({
			...match,
			headers: (match.headers ?? []).filter(header => header.name.trim())
		}))
		.filter(match => (match.headers?.length ?? 0) > 0);
	return next.length ? next : undefined;
}

function MatchCard(props: {
	control: Control<ModelForm>;
	index: number;
	headers: Array<{ id: string; position: number }>;
	onAddHeader: () => void;
	onRemove: () => void;
	onRemoveHeader: (position: number) => void;
}) {
	return (
		<section className="match-card">
			<div className="match-card-header">
				<span />
				<Tooltip content="Remove match">
					<button
						className="icon-button danger"
						type="button"
						aria-label={`Remove match ${props.index + 1}`}
						onClick={props.onRemove}
					>
						<Trash2 size={15} />
					</button>
				</Tooltip>
			</div>
			<div className="match-card-body">
				{props.headers.length ? (
					<div className="match-header-list">
						{props.headers.map(header => (
							<HeaderMatchRow
								key={header.id}
								control={props.control}
								position={header.position}
								onRemove={() => props.onRemoveHeader(header.position)}
							/>
						))}
					</div>
				) : (
					<div className="empty-inline">No header conditions.</div>
				)}
				<button className="button small" type="button" onClick={props.onAddHeader}>
					<Plus size={16} />
					Add header
				</button>
			</div>
		</section>
	);
}

// RHF reads an object with a `target` key as a DOM event, so the header value
// object is passed through an event-shaped wrapper and stored unchanged.
function HeaderMatchRow(props: {
	control: Control<ModelForm>;
	position: number;
	onRemove: () => void;
}) {
	return (
		<div className="header-match-row">
			<Controller
				control={props.control}
				name={`matchHeaders.${props.position}.name`}
				render={({ field }) => (
					<input
						aria-label="Header name"
						value={field.value}
						onChange={event => field.onChange(event.target.value)}
						placeholder="Header name"
					/>
				)}
			/>
			<Controller
				control={props.control}
				name={`matchHeaders.${props.position}.value`}
				render={({ field }) => {
					const value: HeaderMatch['value'] = field.value;
					const regex = Boolean(value && typeof value === 'object' && 'regex' in value);
					const text =
						value && typeof value === 'object'
							? 'regex' in value
								? value.regex
								: 'exact' in value
									? value.exact
									: ''
							: '';
					return (
						<>
							<input
								aria-label="Header value"
								value={text}
								onChange={event =>
									field.onChange({
										target: {
											value: regex ? { regex: event.target.value } : { exact: event.target.value }
										}
									})
								}
								placeholder={regex ? 'Regex value' : 'Exact value'}
							/>
							<label className={regex ? 'regex-toggle selected' : 'regex-toggle'}>
								<input
									type="checkbox"
									checked={regex}
									onChange={event =>
										field.onChange({
											target: { value: event.target.checked ? { regex: text } : { exact: text } }
										})
									}
								/>
								Regex
							</label>
						</>
					);
				}}
			/>
			<Tooltip content="Remove header condition">
				<button
					className="icon-button danger"
					type="button"
					aria-label="Remove header condition"
					onClick={props.onRemove}
				>
					<Trash2 size={15} />
				</button>
			</Tooltip>
		</div>
	);
}
