import { Gauge, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
	type Control,
	Controller,
	type UseFormRegister,
	useFieldArray,
	useForm
} from 'react-hook-form';

import { LostFieldsWarning, UnsupportedInForm, useMergedEdits } from '@/components/EditorContracts';
import { EnumSelector } from '@/components/EnumSelector';
import { MiniMonacoEditor } from '@/components/MiniMonacoEditor';
import { Field, FieldGroup } from '@/components/Primitives';
import type { DescriptorEntry, RemoteRateLimit } from '@/gateway-config';
import { hasUnsupportedTarget, TargetEditor, targetFrom } from '@/policies/PolicyFormControls';
import { PolicySection } from '@/policies/PolicyLayout';
import { cleanEmpty, isRecord } from '@/policies/policyUtils';
import type { RemoteRateLimitDraft, TargetDraft } from '@/policies/types';
import type { SchemaHelp } from '@/schemaHelp';

type FailureMode = 'failClosed' | 'failOpen';
type DescriptorType = 'requests' | 'tokens';

type DescriptorDraft = {
	cost: string;
	limitOverride: string;
	type: DescriptorType;
};
type NestedDescriptor = DescriptorDraft & {
	entries: Array<{ key: string; value: string }>;
};
// Entries form one flat array. Each row stores its owning descriptor position, so
// deleting a descriptor never renames the entry array and never remounts its rows.
type EntryDraft = {
	descriptor: number;
	key: string;
	value: string;
};
type RemoteRateLimitFormValues = {
	descriptors: DescriptorDraft[];
	domain: string;
	entries: EntryDraft[];
	failureMode: FailureMode;
	target: TargetDraft;
};

export function RemoteRateLimitPolicyEditor(props: {
	formId?: string;
	remoteRateLimit: RemoteRateLimitDraft | null | undefined;
	help: SchemaHelp;
	saving: boolean;
	onSave: (remoteRateLimit: RemoteRateLimitDraft) => void;
}) {
	const unsupported =
		props.remoteRateLimit &&
		(isConditional(props.remoteRateLimit) || hasUnsupportedTarget(props.remoteRateLimit));
	const initial = descriptorDrafts(props.remoteRateLimit);
	const { control, getValues, register, setValue, watch } = useForm<RemoteRateLimitFormValues>({
		defaultValues: {
			descriptors: initial.map(draft => ({
				cost: draft.cost,
				limitOverride: draft.limitOverride,
				type: draft.type
			})),
			domain:
				props.remoteRateLimit && !isConditional(props.remoteRateLimit)
					? (props.remoteRateLimit.domain ?? '')
					: '',
			entries: initial.flatMap((draft, descriptor) =>
				draft.entries.map(entry => ({ descriptor, key: entry.key, value: entry.value }))
			),
			failureMode: failureModeFrom(
				props.remoteRateLimit && !isConditional(props.remoteRateLimit)
					? props.remoteRateLimit.failureMode
					: undefined
			),
			target: targetFrom(props.remoteRateLimit, 'ratelimit.default.svc.cluster.local:8081')
		}
	});
	const descriptorArray = useFieldArray({ control, name: 'descriptors' });
	const entryArray = useFieldArray({ control, name: 'entries' });
	// Rows render from the entry field array, which updates in the same render as the descriptor array.
	const rowsByDescriptor: Array<Array<{ id: string; index: number }>> = descriptorArray.fields.map(
		() => []
	);
	entryArray.fields.forEach((field, position) => {
		rowsByDescriptor[field.descriptor]?.push({ id: field.id, index: position });
	});
	const values = watch();
	const entryIndexes = entryIndexesByDescriptor(values.descriptors.length, values.entries);
	const entriesByDescriptor = entryIndexes.map(indexes =>
		indexes.map(position => values.entries[position])
	);
	const [attemptedSave, setAttemptedSave] = useState(false);
	const errors = validate(entriesByDescriptor);

	const merged = useMergedEdits(
		props.remoteRateLimit,
		unsupported ? props.remoteRateLimit : buildRemoteRateLimit(values)
	);

	if (unsupported) {
		return <UnsupportedInForm supports="a single remote rate limit with a host target" />;
	}

	function addDescriptor() {
		const index = getValues('descriptors').length;
		const draft = emptyDescriptor();
		descriptorArray.append(
			{ cost: draft.cost, limitOverride: draft.limitOverride, type: draft.type },
			{ shouldFocus: false }
		);
		draft.entries.forEach(entry => {
			entryArray.append(
				{ descriptor: index, key: entry.key, value: entry.value },
				{ shouldFocus: false }
			);
		});
	}

	function removeDescriptor(index: number) {
		const owned: number[] = [];
		// Remap survivors before removing, using the pre-removal positions. Leaf setValue does
		// not emit the entries array subject, so the entry ids stay attached to their rows.
		getValues('entries').forEach((entry, position) => {
			if (entry.descriptor === index) owned.push(position);
			if (entry.descriptor > index)
				setValue(`entries.${position}.descriptor`, entry.descriptor - 1);
		});
		// Always act on the entry array so its fields pick up the remapped descriptor positions.
		entryArray.remove(owned);
		descriptorArray.remove(index);
	}

	function removeEntry(position: number) {
		const entries = getValues('entries');
		const owner = entries[position].descriptor;
		const ownedCount = entries.filter(entry => entry.descriptor === owner).length;
		entryArray.remove(position);
		// A descriptor always keeps one entry row, so removing its last entry leaves an empty row.
		if (ownedCount === 1)
			entryArray.append({ descriptor: owner, key: '', value: '' }, { shouldFocus: false });
	}

	function save() {
		setAttemptedSave(true);
		if (errors.length) return;
		props.onSave(merged.value as RemoteRateLimitDraft);
	}

	return (
		<form
			id={props.formId}
			className="policy-editor-stack"
			onSubmit={event => {
				event.preventDefault();
				save();
			}}
		>
			<LostFieldsWarning lost={merged.lost} />
			{attemptedSave && errors.length ? (
				<div className="field-error remote-rate-errors">{errors.join(' ')}</div>
			) : null}

			<PolicySection
				icon={<Gauge size={17} />}
				title="Service"
				description="Remote rate limit service and domain used when building descriptor checks."
			>
				<div className="form-grid">
					<Field
						label="Domain"
						path="domain"
						tooltip={props.help.field<RemoteRateLimit>('RemoteRateLimit', 'domain')}
					>
						<input {...register('domain')} placeholder="agentgateway" />
					</Field>
					<FieldGroup
						label="Failure mode"
						path="failureMode"
						tooltip={props.help.field<RemoteRateLimit>('RemoteRateLimit', 'failureMode')}
					>
						<Controller
							control={control}
							name="failureMode"
							render={({ field }) => (
								<EnumSelector<FailureMode>
									ariaLabel="Failure mode"
									value={field.value}
									options={[
										{ value: 'failClosed', label: 'Fail closed' },
										{ value: 'failOpen', label: 'Fail open' }
									]}
									schema={props.help.fieldNode<RemoteRateLimit>('RemoteRateLimit', 'failureMode')}
									onChange={field.onChange}
								/>
							)}
						/>
					</FieldGroup>
				</div>
				{/* RHF treats a plain object with a target key as a DOM event, so object values are wrapped. */}
				<Controller
					control={control}
					name="target"
					render={({ field }) => (
						<TargetEditor
							value={field.value}
							help={props.help}
							tooltip={props.help.field<RemoteRateLimit>('RemoteRateLimit', 'host')}
							onChange={value => field.onChange({ target: { value } })}
						/>
					)}
				/>
			</PolicySection>

			<PolicySection
				icon={<Plus size={17} />}
				title="Descriptors"
				description="Descriptor entries sent to the remote service. Values are CEL expressions evaluated from the request."
			>
				<div className="remote-descriptor-list">
					{descriptorArray.fields.map((field, index) => {
						const descriptor = values.descriptors[index];
						return (
							<DescriptorEditor
								key={field.id}
								control={control}
								descriptor={descriptor}
								help={props.help}
								index={index}
								invalid={
									attemptedSave &&
									entriesByDescriptor[index].every(
										entry => !entry.key.trim() || !entry.value.trim()
									)
								}
								register={register}
								rows={rowsByDescriptor[index] ?? []}
								onAddEntry={() =>
									entryArray.append(
										{ descriptor: index, key: '', value: '' },
										{ shouldFocus: false }
									)
								}
								onRemove={() => removeDescriptor(index)}
								onRemoveEntry={removeEntry}
							/>
						);
					})}
				</div>
				<button className="button" type="button" onClick={addDescriptor}>
					<Plus size={16} />
					Add descriptor
				</button>
			</PolicySection>
		</form>
	);
}

function DescriptorEditor(props: {
	control: Control<RemoteRateLimitFormValues>;
	descriptor: DescriptorDraft;
	help: SchemaHelp;
	index: number;
	invalid: boolean;
	register: UseFormRegister<RemoteRateLimitFormValues>;
	rows: Array<{ id: string; index: number }>;
	onAddEntry: () => void;
	onRemove: () => void;
	onRemoveEntry: (position: number) => void;
}) {
	return (
		<div className={props.invalid ? 'remote-descriptor-card invalid' : 'remote-descriptor-card'}>
			<div className="remote-descriptor-header">
				<div>
					<strong>Descriptor {props.index + 1}</strong>
					<small>
						{props.rows.length} {props.rows.length === 1 ? 'entry' : 'entries'}
					</small>
				</div>
				<button
					className="icon-button danger"
					type="button"
					aria-label="Remove descriptor"
					onClick={props.onRemove}
				>
					<Trash2 size={16} />
				</button>
			</div>
			<FieldGroup
				label="Type"
				path={`descriptors.${props.index}.type`}
				tooltip={props.help.field<DescriptorEntry>('DescriptorEntry', 'type')}
			>
				<Controller
					control={props.control}
					name={`descriptors.${props.index}.type`}
					render={({ field }) => (
						<EnumSelector<DescriptorType>
							ariaLabel={`Descriptor ${props.index + 1} type`}
							value={field.value}
							schema={props.help.fieldNode<DescriptorEntry>('DescriptorEntry', 'type')}
							labels={{ requests: 'Requests', tokens: 'Tokens' }}
							onChange={field.onChange}
						/>
					)}
				/>
			</FieldGroup>
			<FieldGroup
				label="Entries"
				path={`descriptors.${props.index}.entries`}
				tooltip={props.help.field<DescriptorEntry>('DescriptorEntry', 'entries')}
			>
				<div className="remote-entry-list">
					{props.rows.map(row => (
						<div className="remote-entry-row" key={row.id}>
							<input
								className="mono-input compact"
								{...props.register(`entries.${row.index}.key`)}
								placeholder="key"
							/>
							<Controller
								control={props.control}
								name={`entries.${row.index}.value`}
								render={({ field }) => (
									<MiniMonacoEditor
										className="remote-entry-expression"
										language="cel"
										value={field.value}
										onChange={field.onChange}
										placeholder='request.headers["x-user"]'
									/>
								)}
							/>
							<button
								className="icon-button danger"
								type="button"
								aria-label="Remove descriptor entry"
								onClick={() => props.onRemoveEntry(row.index)}
							>
								<Trash2 size={16} />
							</button>
						</div>
					))}
				</div>
				<button className="button" type="button" onClick={props.onAddEntry}>
					<Plus size={16} />
					Add entry
				</button>
			</FieldGroup>
			<div className="form-grid">
				<FieldGroup
					label="Cost expression"
					path={`descriptors.${props.index}.cost`}
					tooltip={props.help.field<DescriptorEntry>('DescriptorEntry', 'cost')}
				>
					<Controller
						control={props.control}
						name={`descriptors.${props.index}.cost`}
						render={({ field }) => (
							<MiniMonacoEditor
								className="mini-monaco-short"
								language="cel"
								value={field.value}
								onChange={field.onChange}
								placeholder={props.descriptor.type === 'tokens' ? 'llm.totalTokens' : '1'}
							/>
						)}
					/>
				</FieldGroup>
				<FieldGroup
					label="Limit override"
					path={`descriptors.${props.index}.limitOverride`}
					tooltip={props.help.field<DescriptorEntry>('DescriptorEntry', 'limitOverride')}
				>
					<Controller
						control={props.control}
						name={`descriptors.${props.index}.limitOverride`}
						render={({ field }) => (
							<MiniMonacoEditor
								className="mini-monaco-short"
								language="cel"
								value={field.value}
								onChange={field.onChange}
								placeholder='{"unit":"minute","requestsPerUnit":100}'
							/>
						)}
					/>
				</FieldGroup>
			</div>
		</div>
	);
}

// Groups flat entry positions by owning descriptor, keeping flat order inside each group.
function entryIndexesByDescriptor(count: number, entries: EntryDraft[]) {
	const indexes: number[][] = Array.from({ length: count }, () => []);
	entries.forEach((entry, position) => {
		indexes[entry.descriptor]?.push(position);
	});
	return indexes;
}

function buildRemoteRateLimit(values: RemoteRateLimitFormValues) {
	const entryIndexes = entryIndexesByDescriptor(values.descriptors.length, values.entries);
	return cleanEmpty({
		...values.target,
		domain: values.domain,
		descriptors: values.descriptors.map((descriptor, index) =>
			cleanEmpty({
				entries: entryIndexes[index].map(position => ({
					key: values.entries[position].key,
					value: values.entries[position].value
				})),
				type: descriptor.type === 'requests' ? undefined : descriptor.type,
				cost: descriptor.cost.trim() || undefined,
				limitOverride: descriptor.limitOverride.trim() || undefined
			})
		),
		failureMode: values.failureMode === 'failClosed' ? undefined : values.failureMode
	}) as RemoteRateLimitDraft;
}

function descriptorDrafts(value: RemoteRateLimitDraft | null | undefined): NestedDescriptor[] {
	if (!value || isConditional(value)) return [emptyDescriptor()];
	const descriptors = Array.isArray(value.descriptors) ? value.descriptors : [];
	return descriptors.length
		? descriptors.map(descriptor => ({
				entries: descriptor.entries?.length
					? descriptor.entries.map(entry => ({
							key: entry.key ?? '',
							value: entry.value ?? ''
						}))
					: [{ key: '', value: '' }],
				type: descriptor.type ?? 'requests',
				cost: descriptor.cost ?? '',
				limitOverride: descriptor.limitOverride ?? ''
			}))
		: [emptyDescriptor()];
}

function emptyDescriptor(): NestedDescriptor {
	return {
		entries: [{ key: 'user', value: 'request.headers["x-user"]' }],
		type: 'requests',
		cost: '',
		limitOverride: ''
	};
}

function failureModeFrom(value: RemoteRateLimitDraft['failureMode'] | undefined): FailureMode {
	return value === 'failOpen' || value === 'FailOpen' ? 'failOpen' : 'failClosed';
}

function isConditional(value: unknown) {
	return isRecord(value) && Array.isArray(value.conditional);
}

function validate(descriptors: EntryDraft[][]) {
	const errors: string[] = [];
	if (
		!descriptors.length ||
		descriptors.every(entries => entries.every(entry => !entry.key.trim() || !entry.value.trim()))
	) {
		errors.push('At least one descriptor entry is required.');
	}
	return errors;
}
